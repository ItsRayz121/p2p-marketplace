// Fallback payment poller — defence-in-depth and PRIMARY detection for TRON.
//
// Runs ~every 60 s. Scans each configured payment network for incoming USDT to the
// gas deposit address, then applies the same matching logic as webhook.routes.ts.
//
//   - EVM (BEP20/ERC20): scans recent blocks via RPC getLogs for Transfer events.
//   - TRON  (TRC20):     queries TronGrid for confirmed TRC20 transfers. Moralis
//                        does NOT support TRON, so the webhook never fires for it —
//                        this poller is the ONLY automatic detection path for TRC20.
//
// On a confirmed, unambiguous match the order is moved to `payment_detected` and gas
// delivery is queued automatically (same path the EVM webhook uses). Ambiguous
// amount matches (>1 candidate order) are parked as unattributed for manual review
// so auto-delivery never credits the wrong user.

import { createPublicClient, http, parseAbiItem } from 'viem'
import { bsc, mainnet } from 'viem/chains'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { sendAdminAlertEmail } from '../services/email.service'
import { createAdminNotif } from '../services/adminNotification.service'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'
import { getAptosHotWalletAddress } from '../lib/gas/aptosWalletService'

// ERC20 Transfer(from, to, value) — indexed from + to allow topic-filter on 'to'
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

// Grace window: attribute payments to orders that expired at most this many ms ago.
// Covers the case where the webhook fired after the order expiry job already ran.
const GRACE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

// USDT TRC20 contract on TRON mainnet, 6 decimals.
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_TRC20_DECIMALS = 6
// only_confirmed=true returns solidified txs; nominal depth used only for display.
const TRON_CONFIRMED_DEPTH = 19
// On a cold start (no cursor) scan this far back so on-time payments aren't missed.
const TRON_COLD_START_LOOKBACK_MS = 30 * 60 * 1000

// Native USDT on Aptos (Tether) — fungible-asset metadata address, 6 decimals.
// Overridable via PlatformConfig key 'gas_usdt_aptos_asset' (e.g. testnet/alt asset).
const USDT_APTOS_ASSET_DEFAULT = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'
const USDT_APTOS_DECIMALS = 6
const APTOS_COLD_START_LOOKBACK_MS = 30 * 60 * 1000

interface NetworkConfig {
  paymentNetwork: string
  viemChain: typeof bsc | typeof mainnet
  rpcUrl: () => string
  usdtContract: `0x${string}`
  usdtDecimals: number
  depositAddressDbKey: string
  depositAddressEnvFn: () => string | undefined
  // How many blocks ≈ the scan window. Keeps getLogs range reasonable.
  // BSC  ~3 s/block → 100 blocks ≈ 5 min
  // ETH ~12 s/block →  30 blocks ≈ 6 min
  scanBlocks: number
  // Minimum block confirmations required before treating the payment as final.
  minConfirmations: number
}

const NETWORK_CONFIGS: NetworkConfig[] = [
  {
    paymentNetwork:      'BEP20',
    viemChain:           bsc,
    rpcUrl:              () => env.BSC_RPC_URL,
    usdtContract:        '0x55d398326f99059fF775485246999027B3197955',
    usdtDecimals:        18,  // Binance-Peg USDT on BSC uses 18 decimals
    depositAddressDbKey: 'gas_usdt_bep20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
    scanBlocks:          100,
    minConfirmations:    3,
  },
  {
    paymentNetwork:      'ERC20',
    viemChain:           mainnet,
    rpcUrl:              () => env.ETHEREUM_RPC_URL,
    usdtContract:        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdtDecimals:        6,
    depositAddressDbKey: 'gas_usdt_erc20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
    scanBlocks:          30,
    minConfirmations:    6,
  },
]

// Heartbeat: record that this network was scanned, so admins can see at a glance
// whether each poller is alive. Read by GET /admin/gas/poller-health.
async function writePollerHeartbeat(network: string, found: number): Promise<void> {
  try {
    await redis.set(`gas_poller_health:${network}`, JSON.stringify({ at: Date.now(), found }))
  } catch {
    /* best-effort — a heartbeat write failure must never break the poller */
  }
}

// Resolve deposit address: DB override takes precedence over env var.
async function resolveDepositAddress(dbKey: string, envValue: string | undefined): Promise<string | null> {
  const dbOverride = await db.platformConfig.findUnique({ where: { key: dbKey } })
  if (dbOverride?.value) return dbOverride.value
  return envValue ?? null
}

// ── Shared matching + auto-delivery ─────────────────────────────────────────────
// Applies the same 3-pass attribution used by the webhook, then queues delivery.
// `getBlockTimestampMs` is chain-specific (EVM fetches the block; TRON already
// knows it) and only consulted for the recently-expired grace check.
async function matchAndDeliver(p: {
  paymentNetwork: string
  txHash: string
  incoming: number
  confirmations: number
  senderAddress?: string
  depositAddress: string
  graceCutoff: Date
  getBlockTimestampMs: () => Promise<number | null>
}): Promise<void> {
  const { paymentNetwork, txHash, incoming, confirmations, senderAddress, depositAddress, graceCutoff } = p

  // Duplicate guard: skip if already attributed to an order past the verification
  // stage. We must NOT skip payment_uploaded orders whose paymentTxHash was set by
  // the user submitting proof — those are exactly what Pass 1 handles.
  const alreadyUsed = await db.gasFeeOrder.findFirst({
    where: { paymentTxHash: txHash, status: { notIn: ['payment_uploaded'] } },
  })
  if (alreadyUsed) return

  const lo = (incoming * 0.99).toFixed(4)
  const hi = (incoming * 1.01).toFixed(4)

  // ── Pass 1: payment_uploaded order where the user submitted this exact tx hash ──
  // Strongest signal — user explicitly provided the hash; skip amount tolerance.
  const txHashUploadedOrder = await db.gasFeeOrder.findFirst({
    where: { status: 'payment_uploaded', paymentNetwork, paymentTxHash: txHash },
  })
  if (txHashUploadedOrder) {
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: txHashUploadedOrder.id, status: 'payment_uploaded' },
      data: {
        status: 'payment_detected',
        paymentVerifiedAt: new Date(),
        verifiedAmount: incoming,
        verifiedAsset: 'USDT',
        verifiedConfirmations: confirmations,
      },
    })
    if (claimed.count > 0) {
      await onPaymentDetected(txHashUploadedOrder.id, txHashUploadedOrder.orderRef, txHashUploadedOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress)
    }
    return
  }

  // ── Pass 2: amount-based match (payment_pending / payment_uploaded with no hash) ──
  // Ambiguity guard: if more than one live order matches this amount, auto-attributing
  // (and now auto-delivering) could credit the wrong user — park it for manual review.
  const candidates = await db.gasFeeOrder.findMany({
    where: {
      status: { in: ['payment_pending', 'payment_uploaded'] },
      paymentNetwork,
      paymentAmount: { gte: lo, lte: hi },
      paymentTxHash: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: 2,
  })

  if (candidates.length > 1) {
    await parkUnattributed(txHash, incoming, paymentNetwork, depositAddress, 'ambiguous_multiple_matches')
    logger.warn({ txHash, incoming, paymentNetwork, candidateCount: candidates.length }, 'gasPaymentPoller: ambiguous amount match — parked, NOT auto-delivering')
    sendAdminAlertEmail(
      'Ambiguous Gas Fee Payment — manual review',
      `A USDT payment (${incoming}) on ${paymentNetwork} matched ${candidates.length} pending gas orders by amount.\n\nTX: ${txHash}\n\nAuto-delivery was skipped to avoid crediting the wrong user. Attribute manually at /admin/gas.`,
    ).catch(() => {})
    return
  }

  const activeOrder = candidates[0]
  if (activeOrder) {
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: activeOrder.id, status: { in: ['payment_pending', 'payment_uploaded'] }, paymentTxHash: null },
      data: {
        status: 'payment_detected',
        paymentTxHash: txHash,
        paymentVerifiedAt: new Date(),
        verifiedAmount: incoming,
        verifiedAsset: 'USDT',
        verifiedConfirmations: confirmations,
      },
    })
    if (claimed.count > 0) {
      await onPaymentDetected(activeOrder.id, activeOrder.orderRef, activeOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress)
    }
    return
  }

  // ── Pass 3: grace match — recently-expired order where payment arrived on time ──
  const expiredOrder = await db.gasFeeOrder.findFirst({
    where: {
      status: 'expired',
      paymentNetwork,
      paymentAmount: { gte: lo, lte: hi },
      expiresAt: { gte: graceCutoff },
      paymentTxHash: null,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (expiredOrder) {
    const blockTimestampMs = await p.getBlockTimestampMs()
    const paidBeforeExpiry =
      blockTimestampMs === null || blockTimestampMs < expiredOrder.expiresAt.getTime()

    if (paidBeforeExpiry) {
      const claimed = await db.gasFeeOrder.updateMany({
        where: { id: expiredOrder.id, status: 'expired', paymentTxHash: null },
        data: {
          status: 'payment_detected',
          paymentTxHash: txHash,
          paymentVerifiedAt: new Date(),
          verifiedAmount: incoming,
          verifiedAsset: 'USDT',
          verifiedConfirmations: confirmations,
        },
      })
      if (claimed.count > 0) {
        await onPaymentDetected(expiredOrder.id, expiredOrder.orderRef, expiredOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress)
        sendAdminAlertEmail(
          `Gas Order Resurrected — Late Payment Detection`,
          `Order ref: ${expiredOrder.orderRef}\nOrder ID: ${expiredOrder.id}\nNetwork: ${paymentNetwork}\nAmount: ${incoming} USDT\nTx Hash: ${txHash}\n\nPayment was on-chain before expiry but the webhook never fired. The poller detected, attributed, and queued delivery automatically.`,
        ).catch(() => {})
      }
      return
    }
  }

  // ── No match — record as unattributed for admin review ────────────────────────
  await parkUnattributed(txHash, incoming, paymentNetwork, depositAddress, 'poller_no_match')
  logger.warn({ txHash, incoming, paymentNetwork }, 'gasPaymentPoller: unattributed transfer — no matching order')
  void createAdminNotif({
    category: 'GAS',
    title: `Unattributed Deposit — ${incoming.toFixed(2)} USDT (${paymentNetwork})`,
    body: `Received ${incoming.toFixed(4)} USDT but no matching order found. Needs manual attribution. Tx: ${txHash.slice(0, 12)}…`,
    href: '/admin/gas/flagged',
    metadata: { txHash, amount: incoming.toFixed(4), network: paymentNetwork },
  })
}

async function parkUnattributed(txHash: string, incoming: number, paymentNetwork: string, depositAddress: string, paymentNote: string): Promise<void> {
  const member = JSON.stringify({
    txHash,
    amount: incoming.toFixed(4),
    network: paymentNetwork,
    toAddress: depositAddress,
    paymentNote,
    detectedAt: new Date().toISOString(),
  })
  await redis.zadd('gas_unattributed', Date.now(), member)
  await redis.zremrangebyrank('gas_unattributed', 0, -101) // keep newest 100
}

// Queue automatic delivery (same path as the webhook), then record ledger + notif.
async function onPaymentDetected(
  orderId: string,
  orderRef: string,
  orderChain: string,
  txHash: string,
  incoming: number,
  confirmations: number,
  paymentNetwork: string,
  senderAddress: string | undefined,
): Promise<void> {
  // Queue delivery FIRST and await it — this is the money path, not fire-and-forget.
  // The worker claims payment_detected → sending via CAS, so a duplicate enqueue is safe.
  try {
    await queues.gasFee.add('deliver', { orderId }, { priority: 1 })
  } catch (err) {
    logger.error({ err, orderId }, 'gasPaymentPoller: failed to queue delivery — will retry next tick (order stays payment_detected)')
  }

  try {
    appendLedgerEntry({
      entryType:      'order_payment',
      chain:          fromDbChain(orderChain) as GasChainId,
      nativeAmount:   0,          // USDT is a token — no native moved
      usdAmount:      incoming,   // USDT ≈ USD 1:1
      tokenSymbol:    'USDT',
      tokenAmount:    incoming,
      txHash,
      ...(senderAddress !== undefined ? { fromAddress: senderAddress } : {}),
      relatedOrderId: orderId,
    }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write order_payment ledger entry'))

    void createAdminNotif({
      category: 'GAS',
      title: `Payment Detected — ${incoming.toFixed(2)} USDT (${paymentNetwork})`,
      body: `Order ${orderRef} payment confirmed on-chain (${confirmations} conf). Delivery queued automatically. Tx: ${txHash.slice(0, 12)}…`,
      href: `/admin/gas/orders/${orderRef}`,
      metadata: { txHash, amount: incoming.toFixed(4), network: paymentNetwork, orderId, confirmations },
    })

    logger.info({ txHash, orderId, network: paymentNetwork, incoming, confirmations }, 'gasPaymentPoller: payment detected — delivery queued')
  } catch (err) {
    logger.warn({ err, orderId, txHash }, 'gasPaymentPoller: onPaymentDetected post-processing failed')
  }
}

// ── EVM scanner (getLogs) ───────────────────────────────────────────────────────
async function scanNetwork(cfg: NetworkConfig): Promise<void> {
  const depositAddress = await resolveDepositAddress(cfg.depositAddressDbKey, cfg.depositAddressEnvFn())
  if (!depositAddress) return  // network not configured

  // Skip if no actionable orders (payment_pending, payment_uploaded, or recently-expired).
  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const activeOrExpired = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: cfg.paymentNetwork,
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (activeOrExpired === 0) { await writePollerHeartbeat(cfg.paymentNetwork, 0); return }

  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: http(cfg.rpcUrl(), { timeout: 10_000 }),
  })

  // Determine block range: last-checked block → current block.
  const redisKey = `gas_poller_last_block:${cfg.paymentNetwork}`
  const currentBlock = await client.getBlockNumber()

  const storedBlock = await redis.get(redisKey)
  const fromBlock = storedBlock
    ? BigInt(storedBlock) + 1n
    : currentBlock - BigInt(cfg.scanBlocks)

  // Nothing new since last run.
  if (fromBlock > currentBlock) { await writePollerHeartbeat(cfg.paymentNetwork, 0); return }

  // Cap range to avoid oversized getLogs calls on first run or after a long gap.
  const maxRange = BigInt(Math.max(cfg.scanBlocks, 500))
  const effectiveFrom = fromBlock < currentBlock - maxRange
    ? currentBlock - maxRange
    : fromBlock

  let logs
  try {
    logs = await client.getLogs({
      address: cfg.usdtContract,
      event:   TRANSFER_EVENT,
      args:    { to: depositAddress as `0x${string}` },
      fromBlock: effectiveFrom,
      toBlock:   currentBlock,
    })
  } catch (err) {
    logger.warn({ err, network: cfg.paymentNetwork, effectiveFrom: effectiveFrom.toString(), currentBlock: currentBlock.toString() }, 'gasPaymentPoller: getLogs failed — will retry next tick')
    return  // don't advance the cursor so we retry same range
  }

  // Advance cursor even when logs is empty so we don't re-scan old blocks.
  await redis.set(redisKey, currentBlock.toString())
  await writePollerHeartbeat(cfg.paymentNetwork, logs.length)

  if (logs.length === 0) return

  logger.info(
    { network: cfg.paymentNetwork, count: logs.length, from: effectiveFrom.toString(), to: currentBlock.toString() },
    'gasPaymentPoller: found Transfer events',
  )

  for (const log of logs) {
    const txHash = log.transactionHash
    if (!txHash) continue

    const rawValue = log.args.value
    if (rawValue === undefined || rawValue === null) continue

    // Confirmation check — only act on payments with enough block depth.
    const confirmations = log.blockNumber != null
      ? Number(currentBlock) - Number(log.blockNumber)
      : 0
    if (confirmations < cfg.minConfirmations) continue

    const incoming = Number(rawValue) / Math.pow(10, cfg.usdtDecimals)
    if (!(incoming > 0)) continue

    const senderAddress = log.args.from ?? undefined

    await matchAndDeliver({
      paymentNetwork: cfg.paymentNetwork,
      txHash,
      incoming,
      confirmations,
      ...(senderAddress !== undefined ? { senderAddress } : {}),
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => {
        if (log.blockNumber == null) return null
        try {
          const block = await client.getBlock({ blockNumber: log.blockNumber })
          return Number(block.timestamp) * 1000
        } catch (err) {
          logger.warn({ err, txHash }, 'gasPaymentPoller: could not fetch block timestamp for grace check')
          return null
        }
      },
    })
  }
}

// ── TRON scanner (TronGrid) ─────────────────────────────────────────────────────
// Moralis can't see TRON, so this is the primary detection path for TRC20 payments.
interface TronTrc20Tx {
  transaction_id?: string
  block_timestamp?: number
  from?: string
  to?: string
  value?: string
  type?: string
  token_info?: { address?: string; decimals?: number; symbol?: string }
}

async function scanTron(): Promise<void> {
  const base = env.TRON_FULLNODE_URL
  if (!base) return // TRON not configured

  const depositAddress = await resolveDepositAddress('gas_usdt_trc20_address', env.GAS_FEE_DEPOSIT_ADDRESS_TRC20)
  if (!depositAddress) return

  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const actionable = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: 'TRC20',
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (actionable === 0) { await writePollerHeartbeat('TRC20', 0); return }

  const cursorKey = `gas_poller_last_ts:TRC20`
  const storedTs = await redis.get(cursorKey)
  const minTimestamp = storedTs ? Number(storedTs) : Date.now() - TRON_COLD_START_LOOKBACK_MS

  const url = new URL(`${base.replace(/\/$/, '')}/v1/accounts/${depositAddress}/transactions/trc20`)
  url.searchParams.set('only_to', 'true')
  url.searchParams.set('only_confirmed', 'true')
  url.searchParams.set('contract_address', USDT_TRC20_CONTRACT)
  url.searchParams.set('limit', '50')
  url.searchParams.set('order_by', 'block_timestamp,asc')
  url.searchParams.set('min_timestamp', String(minTimestamp))

  const headers: Record<string, string> = {}
  // Header name matches the rest of the codebase's TronGrid calls.
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  let transfers: TronTrc20Tx[]
  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      logger.warn({ status: res.status, network: 'TRC20' }, 'gasPaymentPoller: TronGrid request failed — will retry next tick')
      return // don't advance cursor
    }
    const json = (await res.json()) as { data?: TronTrc20Tx[]; success?: boolean }
    transfers = json.data ?? []
  } catch (err) {
    logger.warn({ err, network: 'TRC20' }, 'gasPaymentPoller: TronGrid fetch errored — will retry next tick')
    return // don't advance cursor
  }

  if (transfers.length === 0) { await writePollerHeartbeat('TRC20', 0); return }

  logger.info({ network: 'TRC20', count: transfers.length }, 'gasPaymentPoller: found TRC20 transfers')

  let maxTs = minTimestamp
  for (const t of transfers) {
    const ts = Number(t.block_timestamp ?? 0)
    if (ts > maxTs) maxTs = ts

    const txHash = t.transaction_id
    if (!txHash) continue
    if (t.type && t.type !== 'Transfer') continue
    // Defensive: ensure it's the USDT contract (only_to + contract_address already filter).
    if (t.token_info?.address && t.token_info.address !== USDT_TRC20_CONTRACT) continue

    const decimals = t.token_info?.decimals ?? USDT_TRC20_DECIMALS
    const raw = t.value
    if (!raw) continue
    let incoming: number
    try {
      incoming = Number(BigInt(raw)) / Math.pow(10, decimals)
    } catch {
      continue
    }
    if (!(incoming > 0)) continue

    await matchAndDeliver({
      paymentNetwork: 'TRC20',
      txHash,
      incoming,
      confirmations: TRON_CONFIRMED_DEPTH,
      ...(t.from ? { senderAddress: t.from } : {}),
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => (ts > 0 ? ts : null),
    })
  }

  // Advance cursor. Using the max timestamp seen (inclusive on next run) is safe —
  // the duplicate guard in matchAndDeliver dedupes any boundary tx re-seen.
  await redis.set(cursorKey, String(maxTs))
  await writePollerHeartbeat('TRC20', transfers.length)
}

// ── Aptos scanner (Indexer GraphQL) ─────────────────────────────────────────────
// Moralis can't see Aptos either, so this is the primary detection path for USDT
// paid on Aptos (the APTOS payment network). Queries the Aptos Indexer for
// incoming fungible-asset deposits of USDT to the Aptos gas wallet.
interface AptosFaActivity {
  transaction_version?: number | string
  event_index?: number | string
  amount?: string
  asset_type?: string
  owner_address?: string
  type?: string
  transaction_timestamp?: string
}

async function scanAptos(): Promise<void> {
  const indexerUrl = env.APTOS_INDEXER_URL
  if (!indexerUrl) return

  const depositAddress = await resolveDepositAddress('gas_usdt_aptos_address', getAptosHotWalletAddress() ?? undefined)
  if (!depositAddress) return

  const assetCfg = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_aptos_asset' } })
  const assetType = assetCfg?.value || USDT_APTOS_ASSET_DEFAULT

  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const actionable = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: 'APTOS',
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (actionable === 0) { await writePollerHeartbeat('APTOS', 0); return }

  const cursorKey = 'gas_poller_last_ts:APTOS'
  const storedTs = await redis.get(cursorKey)
  const minTs = storedTs ?? new Date(Date.now() - APTOS_COLD_START_LOOKBACK_MS).toISOString()

  const query = `
    query GasAptosDeposits($owner: String!, $asset: String!, $minTs: timestamp!) {
      fungible_asset_activities(
        where: {
          owner_address: { _eq: $owner },
          asset_type: { _eq: $asset },
          is_transaction_success: { _eq: true },
          type: { _ilike: "%Deposit%" },
          transaction_timestamp: { _gt: $minTs }
        },
        order_by: { transaction_timestamp: asc },
        limit: 50
      ) {
        transaction_version
        event_index
        amount
        asset_type
        owner_address
        type
        transaction_timestamp
      }
    }`

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`

  let activities: AptosFaActivity[]
  try {
    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { owner: depositAddress, asset: assetType, minTs } }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer request failed — will retry next tick')
      return
    }
    const json = (await res.json()) as { data?: { fungible_asset_activities?: AptosFaActivity[] }; errors?: unknown }
    if (json.errors) {
      logger.warn({ errors: json.errors, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer returned GraphQL errors')
      return
    }
    activities = json.data?.fungible_asset_activities ?? []
  } catch (err) {
    logger.warn({ err, network: 'APTOS' }, 'gasPaymentPoller: Aptos indexer fetch errored — will retry next tick')
    return
  }

  if (activities.length === 0) { await writePollerHeartbeat('APTOS', 0); return }

  logger.info({ network: 'APTOS', count: activities.length }, 'gasPaymentPoller: found Aptos USDT deposits')

  let maxTsStr = minTs
  let maxTsMs = Date.parse(minTs)
  for (const a of activities) {
    const ts = a.transaction_timestamp
    // Aptos indexer timestamps are UTC; append Z when absent for correct parsing.
    const tsMs = ts ? Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`) : NaN
    if (Number.isFinite(tsMs) && tsMs > maxTsMs) { maxTsMs = tsMs; maxTsStr = ts! }

    const version = a.transaction_version != null ? String(a.transaction_version) : null
    if (!version) continue
    const eventIdx = a.event_index != null ? String(a.event_index) : '0'
    const txHash = `aptos:${version}:${eventIdx}`

    const raw = a.amount
    if (!raw) continue
    let incoming: number
    try {
      incoming = Number(BigInt(raw)) / Math.pow(10, USDT_APTOS_DECIMALS)
    } catch {
      continue
    }
    if (!(incoming > 0)) continue

    await matchAndDeliver({
      paymentNetwork: 'APTOS',
      txHash,
      incoming,
      confirmations: 1, // is_transaction_success already filtered; Aptos finalizes on commit
      depositAddress,
      graceCutoff,
      getBlockTimestampMs: async () => (Number.isFinite(tsMs) ? tsMs : null),
    })
  }

  await redis.set(cursorKey, maxTsStr)
  await writePollerHeartbeat('APTOS', activities.length)
}

export async function runGasPaymentPoller(): Promise<void> {
  for (const cfg of NETWORK_CONFIGS) {
    try {
      await scanNetwork(cfg)
    } catch (err) {
      logger.error({ err, network: cfg.paymentNetwork }, 'gasPaymentPoller: scanNetwork threw unexpectedly')
    }
  }

  try {
    await scanTron()
  } catch (err) {
    logger.error({ err, network: 'TRC20' }, 'gasPaymentPoller: scanTron threw unexpectedly')
  }

  try {
    await scanAptos()
  } catch (err) {
    logger.error({ err, network: 'APTOS' }, 'gasPaymentPoller: scanAptos threw unexpectedly')
  }
}
