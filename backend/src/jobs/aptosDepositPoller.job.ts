// Aptos USER deposit poller.
//
// Detects inbound USDT (Tether fungible asset, 6 decimals) to each user's
// per-user HD-derived Aptos deposit address and credits their internal RupChain
// balance — the Aptos analogue of the EVM Moralis-stream + reconciler path.
//
// SAFETY MODEL (money movement — read before editing):
//   - Each FA "Deposit" activity is uniquely keyed by `aptos:{version}:{idx}`.
//     event_index differs per recipient even within one batch tx, so two users
//     funded in the same tx never collide.
//   - That synthetic hash is the Deposit row's txHash; the unique
//     (txHash, chain, asset) constraint + the atomic detected→credited gate in
//     creditDetectedDeposit make crediting EXACTLY-ONCE. Re-seeing an activity
//     (e.g. from the cursor overlap below) can never double-credit.
//   - The cursor is advanced with a deliberate overlap so a boundary event is
//     never skipped; idempotency absorbs the re-reads.
//   - We only act on is_transaction_success=true activities. Aptos has BFT
//     finality, so a committed successful tx is final → credit at 1 conf.

import { formatUnits } from 'viem'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { walletAptosCustodyIsConfigured } from '../lib/walletCrypto'
import { creditDetectedDeposit } from '../services/depositWatcher.service'

// Native USDT on Aptos (Tether) — fungible-asset metadata address, 6 decimals.
// Mirrors gasPaymentPoller; overridable via PlatformConfig 'gas_usdt_aptos_asset'.
const USDT_APTOS_ASSET_DEFAULT = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'
const USDT_APTOS_DECIMALS = 6

// Canonical Wallet.network label for Aptos USDT — MUST match the label the
// balance view and withdrawal flow look up (frontend COIN_NETWORKS → 'Aptos').
const APTOS_NETWORK_LABEL = 'Aptos'
// Deposit.chain identifier for Aptos rows (no EVM registry entry exists).
const APTOS_CHAIN_ID = 'aptos'

const CURSOR_KEY = 'aptos_deposit_poller_last_ts'
const HEARTBEAT_KEY = 'poller_heartbeat:APTOS_DEPOSIT'
// On a cold start (no cursor) look back this far so recent deposits aren't missed.
const COLD_START_LOOKBACK_MS = 30 * 60 * 1000
// Re-scan this far behind the last-seen timestamp every tick so an event sharing
// the boundary second is never skipped. Idempotency makes the re-reads free.
const CURSOR_OVERLAP_MS = 2 * 60 * 1000
// Addresses per indexer query (keeps the `_in` filter and response bounded).
const ADDR_CHUNK = 100
const INDEXER_PAGE_LIMIT = 100

interface AptosFaActivity {
  transaction_version?: number | string
  event_index?: number | string
  amount?: string
  asset_type?: string
  owner_address?: string
  type?: string
  transaction_timestamp?: string
}

/** Normalize an Aptos address to canonical 0x + 64 lowercase hex (pad leading zeros). */
function normalizeAptosAddr(addr: string): string {
  const hex = addr.replace(/^0x/i, '').toLowerCase()
  return '0x' + hex.padStart(64, '0')
}

async function writeHeartbeat(payload: Record<string, unknown>): Promise<void> {
  try {
    await redis.set(HEARTBEAT_KEY, JSON.stringify({ ...payload, at: new Date().toISOString() }))
  } catch {
    /* heartbeat is best-effort */
  }
}

async function getUsdtAsset(): Promise<string> {
  const cfg = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_aptos_asset' } })
  return cfg?.value || USDT_APTOS_ASSET_DEFAULT
}

async function queryDeposits(
  indexerUrl: string,
  owners: string[],
  asset: string,
  minTs: string,
): Promise<AptosFaActivity[] | null> {
  const query = `
    query UserAptosDeposits($owners: [String!], $asset: String!, $minTs: timestamp!) {
      fungible_asset_activities(
        where: {
          owner_address: { _in: $owners },
          asset_type: { _eq: $asset },
          is_transaction_success: { _eq: true },
          type: { _ilike: "%Deposit%" },
          transaction_timestamp: { _gt: $minTs }
        },
        order_by: { transaction_timestamp: asc },
        limit: ${INDEXER_PAGE_LIMIT}
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

  try {
    const res = await fetch(indexerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { owners, asset, minTs } }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status }, 'aptosDepositPoller: indexer HTTP error — will retry next tick')
      return null
    }
    const json = (await res.json()) as { data?: { fungible_asset_activities?: AptosFaActivity[] }; errors?: unknown }
    if (json.errors) {
      logger.warn({ errors: json.errors }, 'aptosDepositPoller: indexer GraphQL errors')
      return null
    }
    return json.data?.fungible_asset_activities ?? []
  } catch (err) {
    logger.warn({ err }, 'aptosDepositPoller: indexer fetch error — will retry next tick')
    return null
  }
}

/**
 * Idempotently record + credit a single inbound Aptos USDT transfer.
 * Returns true when a NEW credit was applied (for logging/heartbeat counts).
 */
async function recordAndCredit(params: {
  txHash: string
  asset: string
  toAddress: string
  userId: string
  humanAmount: string
}): Promise<boolean> {
  const { txHash, asset, toAddress, userId, humanAmount } = params

  // Idempotent insert: the unique (txHash, chain, asset) constraint means a
  // re-seen activity finds the existing row instead of duplicating it.
  const existing = await db.deposit.findUnique({
    where: { txHash_chain_asset: { txHash, chain: APTOS_CHAIN_ID, asset } },
  })
  if (existing && existing.status === 'credited') return false

  const deposit = existing ?? (await db.deposit.create({
    data: {
      txHash,
      chain: APTOS_CHAIN_ID,
      asset,
      symbol: 'USDT',
      fromAddress: '', // sender not captured for FA deposits; not needed to credit
      toAddress,
      amount: humanAmount,
      confirmations: 1, // committed + success = final on Aptos
      userId,
      status: 'detected',
    },
  }))

  const outcome = await creditDetectedDeposit(deposit.id, {
    source: 'aptos-poller',
    networkOverride: APTOS_NETWORK_LABEL,
  })

  if (outcome.status === 'credited' && !outcome.alreadyCredited) {
    logger.info(
      { depositId: deposit.id, userId, amount: humanAmount, txHash },
      'aptosDepositPoller: USDT deposit credited',
    )
    return true
  }
  if (outcome.status === 'rejected') {
    logger.error({ depositId: deposit.id, userId, txHash, reason: outcome.reason }, 'aptosDepositPoller: credit rejected — flagged for admin review')
  }
  return false
}

export async function runAptosDepositPoller(): Promise<void> {
  const indexerUrl = env.APTOS_INDEXER_URL
  if (!indexerUrl) {
    await writeHeartbeat({ ok: false, configured: false, error: 'Aptos indexer URL not set' })
    return
  }
  if (!walletAptosCustodyIsConfigured()) {
    await writeHeartbeat({ ok: false, configured: false, error: 'wallet custody / sha3-256 not available' })
    return
  }

  // Load every per-user Aptos deposit address → userId map.
  const rows = await db.depositAddress.findMany({
    where: { chainFamily: 'APTOS' },
    select: { address: true, userId: true },
  })
  if (rows.length === 0) {
    await writeHeartbeat({ ok: true, configured: true, addresses: 0, credited: 0 })
    return
  }

  const ownerToUser = new Map<string, string>()
  for (const r of rows) ownerToUser.set(normalizeAptosAddr(r.address), r.userId)
  const owners = [...ownerToUser.keys()]

  const asset = await getUsdtAsset()

  const storedTs = await redis.get(CURSOR_KEY)
  const baseTs = storedTs ? Date.parse(storedTs) : Date.now() - COLD_START_LOOKBACK_MS
  // Apply the overlap so a boundary-second event is never skipped.
  const minTs = new Date((Number.isFinite(baseTs) ? baseTs : Date.now() - COLD_START_LOOKBACK_MS) - CURSOR_OVERLAP_MS).toISOString()

  let maxTsMs = Date.parse(minTs)
  let maxTsStr = minTs
  let credited = 0
  let seen = 0
  let indexerFailed = false

  for (let i = 0; i < owners.length; i += ADDR_CHUNK) {
    const chunk = owners.slice(i, i + ADDR_CHUNK)
    const activities = await queryDeposits(indexerUrl, chunk, asset, minTs)
    if (activities === null) { indexerFailed = true; continue }

    for (const a of activities) {
      seen++
      const ts = a.transaction_timestamp
      const tsMs = ts ? Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`) : NaN
      if (Number.isFinite(tsMs) && tsMs > maxTsMs) { maxTsMs = tsMs; maxTsStr = ts! }

      const version = a.transaction_version != null ? String(a.transaction_version) : null
      if (!version) continue
      const eventIdx = a.event_index != null ? String(a.event_index) : '0'
      const txHash = `aptos:${version}:${eventIdx}`

      const owner = a.owner_address ? normalizeAptosAddr(a.owner_address) : null
      const userId = owner ? ownerToUser.get(owner) : undefined
      if (!userId) continue // not one of our addresses (shouldn't happen given the filter)

      const raw = a.amount
      if (!raw) continue
      let humanAmount: string
      try {
        humanAmount = formatUnits(BigInt(raw), USDT_APTOS_DECIMALS)
      } catch {
        continue
      }
      if (!(Number(humanAmount) > 0)) continue

      try {
        if (await recordAndCredit({ txHash, asset, toAddress: owner!, userId, humanAmount })) credited++
      } catch (err) {
        logger.error({ err, txHash, userId }, 'aptosDepositPoller: recordAndCredit threw — will retry next tick')
      }
    }
  }

  // Only advance the cursor if no chunk's indexer call failed — otherwise we
  // could skip past deposits that a failed page would have returned. On failure
  // we keep the old cursor and re-scan next tick (idempotency makes that safe).
  if (!indexerFailed) {
    await redis.set(CURSOR_KEY, maxTsStr)
  }

  await writeHeartbeat({
    ok: !indexerFailed,
    configured: true,
    addresses: owners.length,
    seen,
    credited,
    ...(indexerFailed ? { error: 'one or more indexer pages failed' } : {}),
  })
}
