import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { timingSafeEqual, createHmac } from 'node:crypto'
import { keccak256, toBytes } from 'viem'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'
import {
  normalizeMoralisEvent,
  processDepositEvent,
} from '../services/depositWatcher.service'

/**
 * Compute a candidate Moralis Streams signature.
 *
 * Historically Moralis has shipped two slightly different schemes:
 *   - V2 / current docs: keccak256( body_string + secret )
 *   - Some SDK examples:  keccak256( body_string + apiKey ) where the variable
 *     is misleadingly named — same algorithm, the secret value is taken from
 *     the dashboard's Webhook Secret field.
 *
 * `bodyString` is either the raw bytes (preferred, exact wire bytes) or the
 * re-serialised parsed body (fallback when raw isn't available).
 */
function candidateSignatures(bodyString: string, secret: string) {
  return {
    keccakBodySecret: keccak256(toBytes(bodyString + secret)),
    // legacy HMAC-SHA256 fallback in case the workspace was migrated from an
    // older signing scheme. Cheap to compute and lets us tell ops which path
    // is being used.
    hmacSha256: '0x' + createHmac('sha256', secret).update(bodyString).digest('hex'),
  }
}

function safeEqual(a: string, b: string): boolean {
  try {
    const aa = Buffer.from(a)
    const bb = Buffer.from(b)
    if (aa.length !== bb.length) return false
    return timingSafeEqual(aa, bb)
  } catch {
    return false
  }
}

interface VerificationOutcome {
  matched: boolean
  scheme: 'keccak-raw' | 'keccak-reserialised' | 'hmac-raw' | 'hmac-reserialised' | 'none'
}

function verifyMoralisSignature(
  rawBody: string | undefined,
  parsedBody: unknown,
  signatureHeader: string | undefined,
  secret: string,
): VerificationOutcome {
  if (!signatureHeader) return { matched: false, scheme: 'none' }

  // Try raw-bytes signing first — this is what Moralis actually does on the
  // wire. Re-serialisation only matches if the producer's JSON formatter is
  // byte-identical to Node's `JSON.stringify`.
  if (rawBody !== undefined) {
    const c = candidateSignatures(rawBody, secret)
    if (safeEqual(signatureHeader, c.keccakBodySecret)) return { matched: true, scheme: 'keccak-raw' }
    if (safeEqual(signatureHeader, c.hmacSha256)) return { matched: true, scheme: 'hmac-raw' }
    // Also try without the 0x prefix in either direction — some implementations
    // emit / expect un-prefixed hex.
    const stripped = signatureHeader.startsWith('0x') ? signatureHeader.slice(2) : '0x' + signatureHeader
    if (safeEqual(stripped, c.keccakBodySecret)) return { matched: true, scheme: 'keccak-raw' }
    if (safeEqual(stripped, c.hmacSha256)) return { matched: true, scheme: 'hmac-raw' }
  }

  // Fallback: parsed-and-re-serialised body. Last resort because formatter
  // differences (whitespace, number/null normalisation) can break this.
  const reserialised = JSON.stringify(parsedBody)
  const c2 = candidateSignatures(reserialised, secret)
  if (safeEqual(signatureHeader, c2.keccakBodySecret)) return { matched: true, scheme: 'keccak-reserialised' }
  if (safeEqual(signatureHeader, c2.hmacSha256)) return { matched: true, scheme: 'hmac-reserialised' }
  const stripped2 = signatureHeader.startsWith('0x') ? signatureHeader.slice(2) : '0x' + signatureHeader
  if (safeEqual(stripped2, c2.keccakBodySecret)) return { matched: true, scheme: 'keccak-reserialised' }
  if (safeEqual(stripped2, c2.hmacSha256)) return { matched: true, scheme: 'hmac-reserialised' }

  return { matched: false, scheme: 'none' }
}

/**
 * Capture the literal request bytes for `/webhooks/deposit` so we can verify
 * the signature against the exact JSON Moralis put on the wire. Without this
 * hook we'd have to re-serialise `req.body`, which only works if our
 * JSON.stringify is byte-identical to whatever Moralis used.
 *
 * Implemented per-route via `preParsing`. No additional dependency.
 */
async function captureRawBody(request: FastifyRequest, _reply: unknown, payload: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []
  for await (const chunk of payload) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  const buf = Buffer.concat(chunks)
  ;(request as unknown as { rawBody?: string }).rawBody = buf.toString('utf8')
  return Readable.from(buf)
}

export async function webhookRoutes(app: FastifyInstance) {
  // POST /api/webhooks/deposit — CSRF exempt (see lib/csrf.ts CSRF_EXEMPT).
  //
  // Moralis Streams verifies the endpoint by sending a signed POST with empty
  // arrays (no txs / no erc20Transfers). We must:
  //   1) verify the signature using Moralis's scheme (keccak256(body + secret))
  //   2) return 200 OK with a JSON body even when there's nothing to process
  // Anything else (401, 500, HTML body, redirect) makes the dashboard report
  // "Could not send test webhook".
  app.post('/webhooks/deposit', {
    // Capture exact wire bytes for signature verification. Must run before
    // Fastify's JSON parser consumes the stream.
    preParsing: captureRawBody,
  }, async (req, reply) => {
    const signatureHeader = (req.headers['x-signature'] as string | undefined) ?? undefined
    const altSignature = (req.headers['x-signature-256'] as string | undefined) ?? undefined
    const rawBody = (req as unknown as { rawBody?: string }).rawBody

    if (!env.MORALIS_WEBHOOK_SECRET) {
      logger.error('MORALIS_WEBHOOK_SECRET not configured — refusing webhook')
      return reply.code(503).send({ success: false, error: 'webhook_not_configured' })
    }

    // Safe diagnostic log. NEVER logs the secret. NEVER logs full body
    // content. Logs only header presence/shape, body length, and a short
    // prefix to confirm content-type framing.
    const bodyPreviewSafe = rawBody
      ? rawBody.slice(0, Math.min(120, rawBody.length))
      : '<no-raw-body>'
    logger.info(
      {
        headers: {
          xSignaturePresent: !!signatureHeader,
          xSignatureLength: signatureHeader?.length,
          xSignaturePrefix: signatureHeader?.slice(0, 10),
          xSignature256Present: !!altSignature,
          contentType: req.headers['content-type'],
          userAgent: req.headers['user-agent'],
        },
        bodyBytes: rawBody?.length,
        bodyPreview: bodyPreviewSafe,
        secretLength: env.MORALIS_WEBHOOK_SECRET.length,
      },
      'Webhook received',
    )

    const outcome = verifyMoralisSignature(
      rawBody,
      req.body,
      signatureHeader ?? altSignature,
      env.MORALIS_WEBHOOK_SECRET,
    )

    if (!outcome.matched) {
      // Diagnostic only: log the FIRST 12 CHARS of every candidate signature
      // we computed so the user (and we) can compare against what Moralis
      // sent. We never log the full computed signatures (would let an attacker
      // confirm an exfiltrated secret) and never the secret itself.
      const candidates = rawBody
        ? candidateSignatures(rawBody, env.MORALIS_WEBHOOK_SECRET)
        : candidateSignatures(JSON.stringify(req.body), env.MORALIS_WEBHOOK_SECRET)
      logger.warn(
        {
          received: signatureHeader?.slice(0, 14),
          computed: {
            keccakRawPrefix: candidates.keccakBodySecret.slice(0, 14),
            hmacPrefix: candidates.hmacSha256.slice(0, 14),
          },
          source: rawBody ? 'raw' : 're-serialised',
        },
        'Webhook signature mismatch — see headers/body shape above to diagnose',
      )
      return reply.code(401).send({ success: false, error: 'invalid_signature' })
    }

    logger.info({ scheme: outcome.scheme }, 'Webhook signature verified')

    // The webhook is shared between two payload shapes:
    //   (a) Native Moralis Streams payload (chainId + txs/erc20Transfers arrays)
    //   (b) Legacy normalized payload used by InstantBuy / GasFee matching
    //       ({ txHash, toAddress, amount, coin, network, confirmations })
    //
    // We dispatch (a) to the deposit watcher and fall through to (b) for the
    // InstantBuy/GasFee paths that already exist below. A real Moralis payload
    // does not carry InstantBuy/GasFee metadata, so those branches simply
    // produce no match — safe to run unconditionally.
    const payload = req.body as {
      // Moralis-style
      chainId?: string
      streamId?: string
      tag?: string
      confirmed?: boolean
      txs?: unknown[]
      erc20Transfers?: unknown[]
      abi?: unknown
      block?: unknown
      // Legacy / normalized
      txHash?: string
      toAddress?: string
      amount?: string
      coin?: string
      network?: string
      confirmations?: number
    }

    // Treat anything that looks Moralis-shaped as a Moralis payload. The
    // dashboard's "Test webhook" button sends a minimal verification ping
    // that always contains `streamId`/`chainId`/`tag` but may omit one or
    // both arrays — we still need to 200-OK it.
    const looksLikeMoralis = !!(
      payload.chainId ||
      payload.streamId ||
      payload.tag ||
      'confirmed' in payload ||
      payload.abi !== undefined ||
      payload.block !== undefined
    )

    if (looksLikeMoralis) {
      const events = normalizeMoralisEvent(payload)
      const results = []
      for (const event of events) {
        try {
          const r = await processDepositEvent(event)
          results.push({ txHash: event.txHash, asset: event.asset, result: r })
        } catch (err) {
          logger.error({ err, txHash: event.txHash }, 'Deposit watcher failed')
          results.push({ txHash: event.txHash, asset: event.asset, error: 'processing_failed' })
        }
      }
      // Legacy InstantBuy/GasFee matching is skipped for Moralis-style payloads —
      // those flows use the normalized shape below.
      return reply.send({ success: true, processed: results.length, results })
    }

    const { txHash, toAddress, coin } = payload

    if (!txHash || !toAddress) {
      return reply.code(400).send({ error: 'Missing required fields' })
    }

    // 2. Idempotency check (legacy path only — Moralis events are de-duped
    //    inside processDepositEvent via the (txHash, chain, asset) unique).
    const idemKey = `webhook_event:${txHash}`
    const alreadyProcessed = await redis.get(idemKey)
    if (alreadyProcessed) {
      logger.info({ txHash }, 'Webhook already processed, skipping')
      return reply.send({ success: true, skipped: true })
    }

    // Mark as processing
    await redis.setex(idemKey, 86400, '1')

    // 3. Match InstantBuyOrder
    const instantOrder = await db.instantBuyOrder.findFirst({
      where: {
        status: 'payment_pending',
        ...(coin ? { coin } : {}),
      },
    })

    if (instantOrder) {
      await db.instantBuyOrder.update({
        where: { id: instantOrder.id },
        data: {
          status: 'payment_uploaded',
          incomingTxHash: txHash,
        },
      })
      logger.info({ txHash, orderId: instantOrder.id }, 'Deposit detected for instant buy order')
    }

    // 4. Match GasFeeOrder
    const gasOrder = await db.gasFeeOrder.findFirst({
      where: {
        toAddress: toAddress,
        status: 'payment_pending',
      },
    })

    if (gasOrder) {
      await db.gasFeeOrder.update({
        where: { id: gasOrder.id },
        data: {
          status: 'payment_detected',
          paymentTxHash: txHash,
        },
      })
      // Queue gas fee delivery
      await queues.gasFee.add('deliver', { orderId: gasOrder.id })
      logger.info({ txHash, orderId: gasOrder.id }, 'Payment detected for gas fee order')
    }

    return reply.send({ success: true })
  })
}
