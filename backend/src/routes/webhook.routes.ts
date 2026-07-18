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
import { createAdminNotif } from '../services/adminNotification.service'
import { getEffectiveDepositAddress } from '../lib/gas/gasWalletService'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain, toDbChain, GAS_CHAINS, paymentNetworkSettlementChain } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'
import { getHotWalletBalance } from '../lib/gas/gas.balance'
import { matchAndDeliverGasPayment } from '../lib/gas/gas.matching'
import type { NormalizedDepositEvent } from '../services/depositWatcher.service'

// Map from the EVM numeric chainId (decoded from Moralis payload.chainId hex)
// to the GasChainId used internally.  All EVM chains share the same hot-wallet
// address so we MUST resolve by chainId, not just by address.
const EVM_CHAIN_ID_TO_GAS_CHAIN: Record<number, GasChainId> = {
  1:     'ETHEREUM',
  56:    'BSC',
  137:   'MATIC',
  42161: 'ARB',
  10:    'OP',
  8453:  'BASE',
  43114: 'AVAX',
}

// Stablecoins that track USD ≈ 1:1 — used to price token deposits without a feed.
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD'])
function isStablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase())
}

// Resolve token decimals for a hot-wallet deposit. Prefer the count the source
// (Moralis) gave us; otherwise fall back to known stablecoin conventions:
// Binance-Peg USDT on BSC uses 18 decimals, USDT elsewhere uses 6. Default 18.
function resolveTokenDecimals(symbol: string, provided: number | undefined, chain: GasChainId): number {
  if (provided != null && Number.isFinite(provided)) return provided
  if (/usdt|usdc|busd|dai/i.test(symbol)) return chain === 'BSC' ? 18 : 6
  return 18
}

// USDT contracts by gas payment network — used to recognise a gas payment in a
// Moralis ERC20 event without trusting the (sometimes blank) tokenSymbol field.
const USDT_CONTRACT_BY_NETWORK: Record<string, string> = {
  BEP20: '0x55d398326f99059fF775485246999027B3197955', // 18 decimals on BSC
  ERC20: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // 6 decimals on ETH
}

/**
 * Attempt to attribute a Moralis ERC20 transfer to a gas-fee order and auto-release.
 * Returns true if the transfer was a USDT payment to a gas deposit address (whether
 * or not it matched an order) — the caller then skips the external-deposit fallback
 * so the same payment is never double-recorded.
 *
 * This is the webhook's auto-release path. Previously the Moralis branch returned
 * before any gas-order matching ran, so EVM crypto orders never auto-released via
 * webhook — only the (chunk-limited) RPC poller could credit them.
 */
async function tryMatchGasPaymentFromWebhook(event: NormalizedDepositEvent): Promise<boolean> {
  if (event.asset === 'native') return false

  const gasChain = EVM_CHAIN_ID_TO_GAS_CHAIN[event.chainId]
  if (gasChain !== 'BSC' && gasChain !== 'ETHEREUM') return false
  const paymentNetwork = gasChain === 'BSC' ? 'BEP20' : 'ERC20'

  // Must be USDT — match by known contract first, symbol as a fallback.
  const expectedUsdt = USDT_CONTRACT_BY_NETWORK[paymentNetwork]
  const isUsdt =
    (expectedUsdt && event.asset.toLowerCase() === expectedUsdt.toLowerCase()) ||
    /usdt/i.test(event.symbol)
  if (!isUsdt) return false

  // toAddress must be the configured gas deposit address for this network.
  const depositInfo = paymentNetwork === 'BEP20'
    ? getEffectiveDepositAddress('BSC', env.GAS_FEE_DEPOSIT_ADDRESS_BEP20)
    : getEffectiveDepositAddress('ETHEREUM', env.GAS_FEE_DEPOSIT_ADDRESS_ERC20)
  const depositAddress = depositInfo.address
  if (!depositAddress || event.toAddress.toLowerCase() !== depositAddress.toLowerCase()) return false

  const decimals = resolveTokenDecimals(event.symbol, event.decimals, gasChain)
  let incoming: number
  try {
    const { formatUnits } = await import('viem')
    incoming = parseFloat(formatUnits(BigInt(event.amount), decimals))
  } catch {
    incoming = parseFloat(event.amount)
  }
  if (!(incoming > 0)) return false

  // Confirmation gate — CRITICAL. Moralis fires the stream twice per tx:
  //   confirmed:false → normalizeMoralisEvent stamps confirmations=0
  //   confirmed:true  → stamps confirmations=chain.minConfirmations (>=1)
  // We must NOT match/release gas on the unconfirmed sighting (a reorg could
  // orphan it). It IS a gas payment to our deposit address, so return true to
  // suppress the external-deposit fallback, but defer attribution to the
  // confirmed event (or the RPC poller, which has its own confirmation gate).
  if (event.confirmations < 1) {
    logger.info({ txHash: event.txHash, paymentNetwork }, 'Webhook: USDT gas payment seen unconfirmed — deferring release until confirmed')
    return true
  }

  const GRACE_MS = 15 * 60 * 1000
  await matchAndDeliverGasPayment({
    source: 'webhook',
    paymentNetwork,
    txHash: event.txHash,
    incoming,
    confirmations: event.confirmations,
    ...(event.fromAddress ? { senderAddress: event.fromAddress } : {}),
    depositAddress,
    graceCutoff: new Date(Date.now() - GRACE_MS),
    // Webhook fired ⇒ payment is recent; no block-timestamp lookup needed for grace.
    getBlockTimestampMs: async () => null,
  })
  // Whether matched or parked, this WAS a gas payment to the deposit address —
  // suppress the external-deposit fallback to avoid a duplicate ledger row.
  return true
}

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
      // Liveness stamp: lets /admin/deposits/detection-health show how long ago
      // Moralis last delivered ANYTHING — a stale value is the tell for a
      // paused/broken stream (the 2026-07-18 silent-failure incident).
      redis.set('moralis_last_webhook_at', new Date().toISOString()).catch(() => {})
    }

    if (looksLikeMoralis) {
      // Warn when the incoming streamId doesn't match any configured stream.
      // A single Moralis stream can cover multiple chains (multi-chain stream),
      // so the same ID in several MORALIS_STREAM_ID_* vars is intentional.
      // A mismatch usually means a stale stream or wrong webhook URL in the dashboard.
      if (payload.streamId) {
        const configuredIds = new Set(
          [
            env.MORALIS_STREAM_ID_ETHEREUM,
            env.MORALIS_STREAM_ID_BSC,
            env.MORALIS_STREAM_ID_POLYGON,
            env.MORALIS_STREAM_ID_ARBITRUM,
            env.MORALIS_STREAM_ID_OPTIMISM,
            env.MORALIS_STREAM_ID_BASE,
          ].filter(Boolean),
        )
        if (!configuredIds.has(payload.streamId)) {
          logger.warn(
            { incomingStreamId: payload.streamId },
            'Webhook streamId does not match any configured MORALIS_STREAM_ID_* — ' +
            'check the dashboard or set the matching env var (note: one multi-chain stream ID can appear in multiple vars)',
          )
        }
      }

      const events = await normalizeMoralisEvent(payload)

      // Pre-load all active hot wallet addresses once for this batch so we can
      // detect direct sends to the hot wallet without an extra DB hit per event.
      const hotWallets = await db.gasHotWallet.findMany({
        where: { isActive: true },
        select: { address: true, chain: true },
      })
      const hotWalletSet = new Set(hotWallets.map((w) => w.address.toLowerCase()))

      const results = []
      for (const event of events) {
        try {
          const r = await processDepositEvent(event)
          results.push({ txHash: event.txHash, asset: event.asset, result: r })

          // ── Gas-fee auto-release ──────────────────────────────────────────────
          // If this is a USDT transfer to a gas deposit address, attribute it to a
          // pending gas order and queue delivery. Runs BEFORE the external-deposit
          // fallback so a matched payment is recorded as order_payment, not as a
          // duplicate hot-wallet deposit.
          const gasMatched = await tryMatchGasPaymentFromWebhook(event)
          if (gasMatched) continue

          // If this event was ignored AND the destination is a hot wallet address,
          // it is a direct top-up (e.g. admin sends native tokens to fund the wallet).
          // Record it as an external_hot_wallet_deposit ledger entry so it appears
          // in Gas Wallet Activity.
          if (r.status === 'ignored' && hotWalletSet.has(event.toAddress.toLowerCase())) {
            // Resolve which chain this deposit is actually on using event.chainId
            // (from payload.chainId hex). All EVM chains share one address, so we
            // MUST NOT pick by address alone — that would record BNB-on-BSC as ETH.
            const eventGasChain = EVM_CHAIN_ID_TO_GAS_CHAIN[event.chainId]
            const eventDbChain  = eventGasChain ? toDbChain(eventGasChain) : undefined

            // Find wallet matching address + exact chain; fall back to address-only
            // for unknown chain IDs (non-EVM future chains, testnet, etc.).
            const hw = (
              eventDbChain
                ? hotWallets.find((w) =>
                    w.address.toLowerCase() === event.toAddress.toLowerCase() &&
                    w.chain === eventDbChain,
                  )
                : undefined
            ) ?? hotWallets.find((w) => w.address.toLowerCase() === event.toAddress.toLowerCase())

            if (!eventGasChain) {
              logger.warn(
                { eventChainId: event.chainId, toAddress: event.toAddress },
                'Webhook: unknown EVM chainId — falling back to first address match for hot-wallet ledger entry',
              )
            }

            if (hw) {
              const hwChainId = fromDbChain(hw.chain) as GasChainId
              const sym = GAS_CHAINS[hwChainId]?.nativeSymbol ?? hw.chain
              const isToken = event.asset !== 'native'
              const { formatUnits } = await import('viem')

              if (isToken) {
                // ── ERC20/BEP20 TOKEN deposit (e.g. USDT) ─────────────────────
                // NEVER apply native 18-dec scaling or the native symbol here —
                // that mislabels USDT as BNB/ETH (root cause of the "+0.16 BNB"
                // bug). Use the token's real decimals (from Moralis, or a USDT
                // fallback) and record it as a token entry with token-priced USD.
                const decimals = resolveTokenDecimals(event.symbol, event.decimals, hwChainId)
                let tokenAmount: number
                try {
                  tokenAmount = parseFloat(formatUnits(BigInt(event.amount), decimals))
                } catch {
                  tokenAmount = parseFloat(event.amount)
                }
                if (tokenAmount > 0) {
                  const tokenSym = (event.symbol || 'TOKEN').toUpperCase()
                  // USD value: stablecoins ≈ $1; other tokens unknown → 0 (priced manually).
                  const usdAmount = isStablecoin(tokenSym) ? tokenAmount : 0
                  // sourceKey includes the contract so a tx moving both native + token
                  // produces two distinct, non-colliding entries.
                  const sourceKey = `MORALIS:${hw.chain}:${event.txHash}:${event.toAddress.toLowerCase()}:${event.asset.toLowerCase()}`

                  logger.info(
                    { source: 'MORALIS_WEBHOOK', chain: hw.chain, txHash: event.txHash, address: event.toAddress, tokenSymbol: tokenSym, tokenAmount, decimals, sourceKey },
                    'External hot-wallet TOKEN deposit detected via Moralis webhook',
                  )

                  appendLedgerEntry({
                    entryType:   'external_hot_wallet_deposit',
                    chain:       hwChainId,
                    nativeAmount: 0,           // a token transfer moves no native gas
                    tokenSymbol:  tokenSym,
                    tokenAmount,
                    usdAmount,
                    txHash:      event.txHash,
                    sourceKey,
                    ...(event.fromAddress ? { fromAddress: event.fromAddress } : {}),
                    toAddress:   event.toAddress,
                    notes:       `source:MORALIS_WEBHOOK chain:${hw.chain} token:${tokenSym} contract:${event.asset}`,
                  }).catch((e) => logger.warn({ err: e, txHash: event.txHash }, 'Failed to write external_hot_wallet_deposit (token) ledger entry'))
                  // No native balance changed → no poller baseline refresh needed.
                }
              } else {
                // ── NATIVE deposit (BNB/ETH/etc. directly to hot wallet) ──────
                let nativeAmount: number
                try {
                  nativeAmount = parseFloat(formatUnits(BigInt(event.amount), 18))
                } catch {
                  nativeAmount = parseFloat(event.amount)
                }

                if (nativeAmount > 0) {
                  // Idempotency key: chain + txHash + toAddress.  The same tx on the
                  // same chain can only produce one ledger entry.
                  const sourceKey = `MORALIS:${hw.chain}:${event.txHash}:${event.toAddress.toLowerCase()}`

                  logger.info(
                    { source: 'MORALIS_WEBHOOK', chain: hw.chain, txHash: event.txHash, address: event.toAddress, symbol: sym, amount: nativeAmount, sourceKey },
                    'External hot-wallet deposit detected via Moralis webhook',
                  )

                  appendLedgerEntry({
                    entryType:   'external_hot_wallet_deposit',
                    chain:       hwChainId,
                    nativeAmount,
                    txHash:      event.txHash,
                    sourceKey,
                    ...(event.fromAddress ? { fromAddress: event.fromAddress } : {}),
                    toAddress:   event.toAddress,
                    notes:       `source:MORALIS_WEBHOOK chain:${hw.chain} symbol:${sym}`,
                  }).catch((e) => logger.warn({ err: e, txHash: event.txHash }, 'Failed to write external_hot_wallet_deposit ledger entry'))

                  // Refresh the balance-diff poller's Redis baseline so the next
                  // 2-minute tick sees diff=0 and doesn't create a duplicate entry.
                  // Key format matches gasHotWalletDepositPoller: chain:address:symbol
                  const pollerKey = `gas_hw_poll_balance:${hw.chain}:${hw.address.toLowerCase()}:${sym}`
                  getHotWalletBalance(hwChainId, hw.address)
                    .then((bal) => redis.set(pollerKey, String(bal), 'EX', 3600))
                    .catch(() => {}) // best-effort; poller self-corrects next tick
                }
              }
            }
          }
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
    // Use SET NX to atomically claim the key. This prevents concurrent requests
    // from double-processing but still allows retries when a previous attempt
    // crashed mid-handler (in which case we delete the key on error below).
    const idemKey = `webhook_event:${txHash}`
    const existing = await redis.get(idemKey)
    if (existing === 'done') {
      logger.info({ txHash }, 'Webhook already processed, skipping')
      return reply.send({ success: true, skipped: true })
    }
    // Claim the slot (NX = only set if not already present).
    // If 'processing' key already exists from a concurrent request, SET NX will
    // return null — we fall through to let the DB-level optimistic locks handle it.
    await redis.set(idemKey, 'processing', 'EX', 86400, 'NX')

    // 3. Match InstantBuyOrder
    // Verify toAddress is the platform's deposit address for this coin/network,
    // then match by amount (±1%) and expiry — never grab a random pending order.
    if (toAddress && coin && payload.network) {
      const depositKey = `deposit_address_${coin.toLowerCase()}_${(payload.network as string).toLowerCase()}`
      const depositConfig = await db.platformConfig.findUnique({ where: { key: depositKey } })
      const platformDepositAddr = depositConfig?.value

      if (platformDepositAddr && toAddress.toLowerCase() === platformDepositAddr.toLowerCase()) {
        const incomingAmount = parseFloat(payload.amount ?? '0')
        if (incomingAmount > 0) {
          const lo = (incomingAmount * 0.99).toFixed(8)
          const hi = (incomingAmount * 1.01).toFixed(8)

          // Fetch up to TWO candidates so we can detect amount ambiguity. On a
          // shared deposit address, matching by amount alone can hit the wrong
          // user's order when two have the same amount — never auto-credit then.
          const candidates = await db.instantBuyOrder.findMany({
            where: {
              status: 'payment_pending',
              coin,
              network: payload.network as string,
              coinAmount: { gte: lo, lte: hi },
              quoteExpiresAt: { gt: new Date() },
              incomingTxHash: null,
            },
            orderBy: { createdAt: 'asc' },
            take: 2,
          })

          if (candidates.length > 1) {
            logger.warn(
              { txHash, amount: incomingAmount, coin, network: payload.network, candidateCount: candidates.length },
              'InstantBuy payment matches multiple pending orders — flagging for manual review, NOT auto-crediting',
            )
            void createAdminNotif({
              category: 'TRADE',
              title: 'Ambiguous InstantBuy Payment — manual review',
              body: `A ${coin} payment (${incomingAmount}) on ${payload.network} matched ${candidates.length} pending orders by amount.\n\nTX: ${txHash}\n\nAuto-credit was skipped to avoid crediting the wrong user. Attribute manually.`,
              href: '/admin/instant-buy',
              telegram: true,
            })
          } else if (candidates.length === 1) {
            const instantOrder = candidates[0]!
            // Optimistic lock: only claim if still payment_pending with no txHash
            const claimed = await db.instantBuyOrder.updateMany({
              where: { id: instantOrder.id, status: 'payment_pending', incomingTxHash: null },
              data: { status: 'payment_uploaded', incomingTxHash: txHash },
            })
            if (claimed.count > 0) {
              logger.info({ txHash, orderId: instantOrder.id }, 'Deposit detected for instant buy order')
            } else {
              logger.warn({ txHash, orderId: instantOrder.id }, 'InstantBuy order already claimed by concurrent webhook')
            }
          }
        }
      }
    }

    // 4. Match GasFeeOrder
    // Payment goes to the platform gas fee deposit address for the relevant payment network.
    // GasFeeOrder.toAddress is the user's delivery address — do not match on it here.
    // Match by deposit address → paymentNetwork (not chain), then by amount (±1% tolerance), oldest first.
    // This allows TRC20/BEP20/ERC20 to be used as payment for any gas delivery chain.
    const GAS_DEPOSIT_ADDRESSES = [
      { address: getEffectiveDepositAddress('TRON',     env.GAS_FEE_DEPOSIT_ADDRESS_TRC20).address, network: 'TRC20' },
      { address: getEffectiveDepositAddress('BSC',      env.GAS_FEE_DEPOSIT_ADDRESS_BEP20).address, network: 'BEP20' },
      { address: getEffectiveDepositAddress('ETHEREUM', env.GAS_FEE_DEPOSIT_ADDRESS_ERC20).address, network: 'ERC20' },
    ].filter((d): d is { address: string; network: string } => !!d.address)

    const matchedDeposit = GAS_DEPOSIT_ADDRESSES.find(
      (d) => toAddress?.toLowerCase() === d.address.toLowerCase(),
    )

    if (matchedDeposit) {
      const incoming = parseFloat((payload as { amount?: string }).amount ?? '0')
      if (incoming > 0) {
        // Tx hash deduplication: reject replay attacks where the same txHash is presented twice.
        const alreadyUsed = await db.gasFeeOrder.findFirst({ where: { paymentTxHash: txHash } })
        if (alreadyUsed) {
          logger.warn({ txHash, existingOrderId: alreadyUsed.id }, 'Duplicate txHash detected — possible replay attack, skipping')
          return reply.send({ success: true })
        }

        // Orders carry a UNIQUE paymentAmount, so try an exact (±epsilon) match
        // first — it attributes to exactly one order even when many share a base
        // gas size. Fall back to a tolerant ±1% match only for under/overpayment.
        const EXACT_EPSILON = 0.0004
        const exLo = (incoming - EXACT_EPSILON).toFixed(4)
        const exHi = (incoming + EXACT_EPSILON).toFixed(4)
        const exactGas = await db.gasFeeOrder.findMany({
          where: {
            status: 'payment_pending',
            paymentNetwork: matchedDeposit.network,
            paymentAmount: { gte: exLo, lte: exHi },
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'asc' },
          take: 2,
        })

        const lo = (incoming * 0.99).toFixed(4)
        const hi = (incoming * 1.01).toFixed(4)

        // Match by paymentNetwork (not chain) so TRC20/BEP20/ERC20 can pay for any delivery chain.
        // Fetch up to TWO so we can detect amount ambiguity on the shared deposit address.
        const gasCandidates = exactGas.length > 0
          ? exactGas
          : await db.gasFeeOrder.findMany({
              where: {
                status: 'payment_pending',
                paymentNetwork: matchedDeposit.network,
                paymentAmount: { gte: lo, lte: hi },
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: 'asc' }, // oldest matching order first (spec §6)
              take: 2,
            })

        if (gasCandidates.length > 1) {
          // Two live orders share this amount — auto-attributing to the oldest could
          // credit the wrong user. Park it as unattributed for manual review.
          const member = JSON.stringify({
            txHash,
            amount: (payload as { amount?: string }).amount,
            network: matchedDeposit.network,
            toAddress,
            paymentNote: 'ambiguous_multiple_matches',
            detectedAt: new Date().toISOString(),
          })
          await redis.zadd('gas_unattributed', Date.now(), member)
          await redis.zremrangebyrank('gas_unattributed', 0, -101)
          logger.warn(
            { txHash, amount: incoming, network: matchedDeposit.network, candidateCount: gasCandidates.length },
            'Gas payment matches multiple pending orders — flagged unattributed, NOT auto-crediting',
          )
          void createAdminNotif({
            category: 'GAS',
            title: 'Ambiguous Gas Fee Payment — manual review',
            body: `A USDT payment (${incoming}) on ${matchedDeposit.network} matched ${gasCandidates.length} pending gas orders by amount.\n\nTX: ${txHash}\n\nAuto-credit was skipped to avoid crediting the wrong user. Attribute manually.`,
            href: '/admin/gas',
            telegram: true,
          })
          return reply.send({ success: true })
        }

        const gasOrder = gasCandidates[0] ?? null

        if (gasOrder) {
          // Atomic claim: updateMany with status guard prevents two concurrent
          // webhook calls from both crediting the same order (optimistic lock).
          const claimed = await db.gasFeeOrder.updateMany({
            where: { id: gasOrder.id, status: 'payment_pending' },
            data: { status: 'payment_detected', paymentTxHash: txHash },
          })
          if (claimed.count === 0) {
            // Another concurrent webhook call already claimed this order.
            logger.warn({ txHash, orderId: gasOrder.id }, 'Gas order already claimed by concurrent webhook — skipping')
            return reply.send({ success: true })
          }
          await queues.gasFee.add('deliver', { orderId: gasOrder.id }, { priority: 1 })
          // Record on the chain the USDT actually settled on (from paymentNetwork),
          // as a USDT token movement — NOT the gas-delivery chain with a native amount.
          const settle = paymentNetworkSettlementChain(matchedDeposit.network)
          appendLedgerEntry({
            entryType:      'order_payment',
            chain:          fromDbChain(gasOrder.chain) as GasChainId,
            ...(settle ? { chainOverride: settle } : {}),
            nativeAmount:   0,
            usdAmount:      incoming,
            tokenSymbol:    'USDT',
            tokenAmount:    incoming,
            txHash,
            relatedOrderId: gasOrder.id,
          }).catch((e) => logger.warn({ err: e, orderId: gasOrder.id }, 'Failed to write order_payment ledger entry'))
          logger.info({ txHash, orderId: gasOrder.id, paymentNetwork: matchedDeposit.network }, 'Payment detected for gas fee order')
        } else {
          // No active match — try recently-expired orders as a grace window.
          // Moralis can fire the webhook after the order expiry job has already run.
          // If payment arrived while the order was still live, attribute it.
          const GRACE_MS = 15 * 60 * 1000
          const graceCutoff = new Date(Date.now() - GRACE_MS)
          const expiredOrder = await db.gasFeeOrder.findFirst({
            where: {
              status:         'expired',
              paymentNetwork: matchedDeposit.network,
              paymentAmount:  { gte: lo, lte: hi },
              expiresAt:      { gte: graceCutoff },
              paymentTxHash:  null,
            },
            orderBy: { createdAt: 'asc' },
          })

          if (expiredOrder) {
            const claimed = await db.gasFeeOrder.updateMany({
              where: { id: expiredOrder.id, status: 'expired', paymentTxHash: null },
              data:  { status: 'payment_detected', paymentTxHash: txHash },
            })
            if (claimed.count > 0) {
              await queues.gasFee.add('deliver', { orderId: expiredOrder.id }, { priority: 1 })
              const settle = paymentNetworkSettlementChain(matchedDeposit.network)
              appendLedgerEntry({
                entryType:      'order_payment',
                chain:          fromDbChain(expiredOrder.chain) as GasChainId,
                ...(settle ? { chainOverride: settle } : {}),
                nativeAmount:   0,
                usdAmount:      incoming,
                tokenSymbol:    'USDT',
                tokenAmount:    incoming,
                txHash,
                relatedOrderId: expiredOrder.id,
              }).catch((e) => logger.warn({ err: e, orderId: expiredOrder.id }, 'Failed to write order_payment ledger entry'))
              logger.info({ txHash, orderId: expiredOrder.id, paymentNetwork: matchedDeposit.network }, 'Late webhook — expired order resurrected (payment was on-time)')
              void createAdminNotif({
                category: 'GAS',
                title: `Gas Order Resurrected — Late Moralis Webhook`,
                body: `Order ref: ${expiredOrder.orderRef}\nOrder ID: ${expiredOrder.id}\nNetwork: ${matchedDeposit.network}\nAmount: ${incoming} USDT\nTx Hash: ${txHash}\n\nMoralis webhook arrived after the order expired. The order was resurrected and delivery queued.`,
                href: `/admin/gas/orders/${expiredOrder.orderRef}`,
                telegram: true,
              })
            }
          } else {
            // No matching active or recently-expired order — log for admin review
            const nearestOrder = await db.gasFeeOrder.findFirst({
              where: {
                status: 'payment_pending',
                paymentNetwork: matchedDeposit.network,
                expiresAt: { gt: new Date() },
              },
              orderBy: { createdAt: 'asc' },
            })
            let paymentNote = 'unmatched'
            if (nearestOrder) {
              const expected = parseFloat(nearestOrder.paymentAmount.toString())
              if (incoming < expected * 0.99) paymentNote = 'underpayment'
              else if (incoming > expected * 1.01) paymentNote = 'overpayment'
              else paymentNote = 'expired_order'
            }

            const member = JSON.stringify({
              txHash,
              amount: (payload as { amount?: string }).amount,
              network: matchedDeposit.network,
              toAddress,
              paymentNote,
              detectedAt: new Date().toISOString(),
            })
            await redis.zadd('gas_unattributed', Date.now(), member)
            await redis.zremrangebyrank('gas_unattributed', 0, -101) // keep newest 100
            logger.warn({ txHash, amount: incoming, paymentNote, network: matchedDeposit.network }, 'Unattributed gas fee payment received')
            void createAdminNotif({
              category: 'GAS',
              title: `Unattributed Gas Fee Payment — ${paymentNote}`,
              body: `A USDT payment arrived at the ${matchedDeposit.network} gas fee deposit address with no matching order.\n\nTX Hash: ${txHash}\nAmount: ${(payload as { amount?: string }).amount} USDT\nNetwork: ${matchedDeposit.network}\nNote: ${paymentNote}\n\nReview and attribute manually.`,
              href: '/admin/gas',
              telegram: true,
            })
          }
        }
      }
    }

    // Mark as fully processed so retries are skipped. Key was set to 'processing'
    // on entry; update to 'done' now that all DB writes succeeded.
    await redis.set(idemKey, 'done', 'EX', 86400)

    return reply.send({ success: true })
  })
}
