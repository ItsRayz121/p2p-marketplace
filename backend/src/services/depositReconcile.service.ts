import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { getAllChains, getRpcUrl } from './chainRegistry.service'
import type { ChainConfig } from '../lib/chains'
import { getBlockNumber, getTransactionReceipt, EvmRpcError } from '../lib/evmRpc'
import { creditDetectedDeposit } from './depositWatcher.service'

/**
 * Reconciler: defence-in-depth against missed/late Moralis Stream events.
 *
 * Every `DEPOSIT_RECONCILE_INTERVAL_SECONDS` (default 60), this scans Deposit
 * rows in status='detected' that are older than `DEPOSIT_RECONCILE_MIN_AGE_SECONDS`
 * (default 30s — avoids racing with the unconfirmed webhook) and younger than
 * `DEPOSIT_RECONCILE_MAX_AGE_HOURS` (default 48 — rows older than that are
 * either orphaned by reorg or need manual admin attention).
 *
 * For each chain, it makes one RPC call to fetch the current block height,
 * then for each pending deposit calls eth_getTransactionReceipt to determine
 * the tx's block. Confirmations = max(0, currentBlock - txBlock + 1).
 *
 * If the tx receipt reports status='0x0' (revert) the deposit is marked
 * rejected. If confirmations >= chain.minConfirmations the deposit is credited
 * via the same atomic credit helper used by the webhook path — so even
 * concurrent webhook+reconciler runs can never double-credit.
 */

export interface ReconcileSummary {
  scanned: number
  updated: number
  credited: number
  rejected: number
  errors: number
  perChain: Record<string, { scanned: number; updated: number; credited: number; rejected: number; errors: number }>
}

function emptyChainBucket() {
  return { scanned: 0, updated: 0, credited: 0, rejected: 0, errors: 0 }
}

/**
 * Refresh the confirmation count for a single Deposit row from on-chain RPC.
 * Returns the updated row + the verification outcome. Does NOT credit — the
 * caller decides what to do next. Used by the reconciler loop and by the
 * admin refresh-confirmations endpoint.
 */
export async function refreshDepositFromRpc(depositId: string): Promise<{
  ok: true
  before: number
  after: number
  threshold: number
  receiptStatus: '0x0' | '0x1'
  txBlock: bigint
  currentBlock: bigint
  txOnChainTo: string | null
  txOnChainFrom: string
} | {
  ok: false
  reason: 'not_found' | 'unsupported_chain' | 'no_rpc_url' | 'receipt_missing' | 'rpc_error'
  message?: string
}> {
  const deposit = await db.deposit.findUnique({ where: { id: depositId } })
  if (!deposit) return { ok: false, reason: 'not_found' }

  const chains = await getAllChains()
  const chain = chains.find((c) => c.id === deposit.chain)
  if (!chain || chain.family !== 'EVM') return { ok: false, reason: 'unsupported_chain' }

  const rpcUrl = getRpcUrl(chain.id)
  if (!rpcUrl) return { ok: false, reason: 'no_rpc_url' }

  try {
    const [currentBlock, receipt] = await Promise.all([
      getBlockNumber(rpcUrl, chain.id),
      getTransactionReceipt(rpcUrl, chain.id, deposit.txHash),
    ])
    if (!receipt) {
      // Receipt missing = tx not yet mined OR dropped from mempool. Leave as-is.
      return { ok: false, reason: 'receipt_missing' }
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0
    const capped = Math.min(confirmations, Number.MAX_SAFE_INTEGER)
    const newConfirmations = Math.max(deposit.confirmations, capped)

    if (newConfirmations !== deposit.confirmations) {
      await db.deposit.update({
        where: { id: deposit.id },
        data: { confirmations: newConfirmations },
      })
      logger.info(
        {
          depositId: deposit.id,
          txHash: deposit.txHash,
          chain: chain.id,
          before: deposit.confirmations,
          after: newConfirmations,
          threshold: chain.minConfirmations,
          source: 'reconciler',
        },
        'Deposit confirmation update',
      )
    }

    return {
      ok: true,
      before: deposit.confirmations,
      after: newConfirmations,
      threshold: chain.minConfirmations,
      receiptStatus: receipt.status,
      txBlock: receipt.blockNumber,
      currentBlock,
      txOnChainTo: receipt.to,
      txOnChainFrom: receipt.from,
    }
  } catch (err) {
    const message = err instanceof EvmRpcError ? err.message : err instanceof Error ? err.message : 'unknown_error'
    logger.warn({ depositId, chain: chain.id, err: message }, 'Reconciler RPC error')
    return { ok: false, reason: 'rpc_error', message }
  }
}

/**
 * Reconcile a single deposit: refresh confirmations, then credit/reject if the
 * outcome warrants it. Idempotent — safe to call concurrently or repeatedly.
 */
async function reconcileOne(deposit: { id: string; chain: string; txHash: string }, chainCfg: ChainConfig): Promise<'credited' | 'updated' | 'rejected' | 'unchanged' | 'error'> {
  const refresh = await refreshDepositFromRpc(deposit.id)
  if (!refresh.ok) {
    // receipt_missing is expected for very-recently-broadcast txs — not an error.
    return refresh.reason === 'receipt_missing' ? 'unchanged' : 'error'
  }

  if (refresh.receiptStatus === '0x0') {
    // Tx reverted on chain. Mark the row rejected so it stops appearing in
    // pending lists and surfaces in admin tooling.
    const updated = await db.deposit.updateMany({
      where: { id: deposit.id, status: 'detected' },
      data: { status: 'rejected', rejectionReason: 'tx_reverted_on_chain' },
    })
    if (updated.count > 0) {
      logger.warn(
        { depositId: deposit.id, txHash: deposit.txHash, chain: chainCfg.id },
        'Deposit rejected — on-chain tx reverted (receipt.status=0x0)',
      )
      return 'rejected'
    }
    return 'unchanged'
  }

  if (refresh.after >= chainCfg.minConfirmations) {
    const outcome = await creditDetectedDeposit(deposit.id, {
      source: 'reconciler',
      extraMetadata: {
        reconciler: {
          currentBlock: refresh.currentBlock.toString(),
          txBlock: refresh.txBlock.toString(),
          confirmations: refresh.after,
        },
      },
    })
    if (outcome.status === 'credited' && !outcome.alreadyCredited) return 'credited'
    if (outcome.status === 'credited' && outcome.alreadyCredited) return 'unchanged'
    return 'error'
  }

  return refresh.after !== refresh.before ? 'updated' : 'unchanged'
}

/**
 * Single reconciler tick. Pulls candidate deposits, batches them by chain so
 * each chain only makes one `eth_blockNumber` call per tick, and processes
 * each candidate.
 */
export async function runReconcileTick(): Promise<ReconcileSummary> {
  const now = Date.now()
  const minAgeMs = env.DEPOSIT_RECONCILE_MIN_AGE_SECONDS * 1000
  const maxAgeMs = env.DEPOSIT_RECONCILE_MAX_AGE_HOURS * 3600_000
  const upperBound = new Date(now - minAgeMs)
  const lowerBound = new Date(now - maxAgeMs)

  const candidates = await db.deposit.findMany({
    where: {
      status: 'detected',
      detectedAt: { gte: lowerBound, lte: upperBound },
    },
    orderBy: { detectedAt: 'asc' },
    take: env.DEPOSIT_RECONCILE_BATCH_SIZE,
    select: { id: true, chain: true, txHash: true },
  })

  const summary: ReconcileSummary = {
    scanned: candidates.length,
    updated: 0,
    credited: 0,
    rejected: 0,
    errors: 0,
    perChain: {},
  }
  if (candidates.length === 0) return summary

  logger.info(
    { batch: candidates.length, minAgeSeconds: env.DEPOSIT_RECONCILE_MIN_AGE_SECONDS },
    'Reconciler tick: scanning detected deposits',
  )

  // Group by chain. Within a chain we run serially to keep the public RPC
  // load light; chains are processed in parallel.
  const byChain = new Map<string, typeof candidates>()
  for (const d of candidates) {
    const list = byChain.get(d.chain) ?? []
    list.push(d)
    byChain.set(d.chain, list)
  }

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, deposits]) => {
      const chainCfg = (await getAllChains()).find((c) => c.id === chainId)
      if (!chainCfg || chainCfg.family !== 'EVM') {
        summary.errors += deposits.length
        return
      }
      const bucket = summary.perChain[chainId] ?? emptyChainBucket()
      bucket.scanned = deposits.length
      summary.perChain[chainId] = bucket

      for (const d of deposits) {
        try {
          const outcome = await reconcileOne(d, chainCfg)
          if (outcome === 'credited') {
            summary.credited += 1
            bucket.credited += 1
          } else if (outcome === 'updated') {
            summary.updated += 1
            bucket.updated += 1
          } else if (outcome === 'rejected') {
            summary.rejected += 1
            bucket.rejected += 1
          } else if (outcome === 'error') {
            summary.errors += 1
            bucket.errors += 1
          }
        } catch (err) {
          summary.errors += 1
          bucket.errors += 1
          logger.error({ depositId: d.id, err: err instanceof Error ? err.message : 'unknown' }, 'Reconciler tick error')
        }
      }
    }),
  )

  if (summary.credited > 0 || summary.rejected > 0 || summary.updated > 0 || summary.errors > 0) {
    logger.info(summary, 'Reconciler tick complete')
  }
  return summary
}
