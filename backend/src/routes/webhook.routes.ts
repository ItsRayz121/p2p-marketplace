import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
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
 * Moralis Streams signs the webhook body as:
 *   signature = keccak256( JSON.stringify(body) + secret )
 *
 * Both sides serialise via JSON.stringify(parsedBody), so we re-serialise the
 * parsed body rather than relying on a raw-body plugin (which isn't registered
 * here). The comparison is timing-safe.
 *
 * Returns true if the signature matches, false otherwise.
 */
function verifyMoralisSignature(body: unknown, signatureHeader: string | undefined, secret: string | undefined): boolean {
  if (!signatureHeader || !secret) return false
  const expected = keccak256(toBytes(JSON.stringify(body) + secret))
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))
  } catch {
    return false
  }
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
  app.post('/webhooks/deposit', async (req, reply) => {
    const signatureHeader = req.headers['x-signature'] as string | undefined

    if (!env.MORALIS_WEBHOOK_SECRET) {
      logger.error('MORALIS_WEBHOOK_SECRET not configured — refusing webhook')
      return reply.code(503).send({ success: false, error: 'webhook_not_configured' })
    }

    if (!verifyMoralisSignature(req.body, signatureHeader, env.MORALIS_WEBHOOK_SECRET)) {
      logger.warn({ signature: signatureHeader }, 'Webhook signature mismatch')
      return reply.code(401).send({ success: false, error: 'invalid_signature' })
    }

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
      txs?: unknown[]
      erc20Transfers?: unknown[]
      // Legacy / normalized
      txHash?: string
      toAddress?: string
      amount?: string
      coin?: string
      network?: string
      confirmations?: number
    }

    // Process Moralis-style payloads through the deposit watcher. Presence of
    // `chainId` is the discriminator — Moralis verification tests include it
    // even when txs/erc20Transfers arrays are empty.
    if (payload.chainId) {
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
