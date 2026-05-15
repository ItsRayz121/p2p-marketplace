/**
 * Hot-wallet refill system.
 *
 * Flow:
 *   checkAndQueueRefills()
 *     → reads enabled thresholds
 *     → samples hot wallet balances
 *     → for each chain below trigger: creates a GasRefillRequest
 *       - if gas_refill_require_approval is true → status = pending_approval
 *       - otherwise                              → status = approved
 *
 *   processApprovedRefills()
 *     → picks up approved requests
 *     → calls sendNativeFromTreasury()
 *     → writes ledger entry
 *     → updates request to completed
 *
 * Admin actions: approveRefill(), cancelRefill() — transition pending_approval rows.
 *
 * Called by the gas-fee queue worker under job name 'refill-check'.
 * Scheduled every 15 minutes via workers.ts.
 */

import { db } from '../prisma'
import { logger as log } from '../logger'
import type { GasChainId } from './gas.chains'
import { fromDbChain, toDbChain } from './gas.chains'
import { getHotWalletBalance, getNativeUsdPrice } from './gas.balance'
import { getTreasuryAddress, sendNativeFromTreasury } from './gas.treasury'
import { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } from './gasWalletService'
import { getEnabledThresholds, dbChainToId } from './gas.thresholds'
import { appendLedgerEntry } from './gas.ledger'

// ── Approval mode check ────────────────────────────────────────────────────────

async function requiresApproval(): Promise<boolean> {
  const row = await db.platformConfig.findUnique({
    where: { key: 'gas_refill_require_approval' },
  })
  return row?.value === 'true'
}

// ── Hot wallet address lookup ──────────────────────────────────────────────────

function getHotWalletAddress(chain: GasChainId): string | null {
  if (chain === 'TRON') return getTronHotWalletAddress()
  // All EVM chains share one derived address
  return getEvmHotWalletAddress()
}

// ── Check balances and queue refills ──────────────────────────────────────────

export async function checkAndQueueRefills(): Promise<{
  checked: number
  queued: number
  skipped: number
  errors: string[]
}> {
  if (!gasWalletIsConfigured()) {
    return { checked: 0, queued: 0, skipped: 0, errors: ['Gas wallet mnemonic not configured'] }
  }

  const thresholds = await getEnabledThresholds()
  const needsApproval = await requiresApproval()
  let queued = 0
  let skipped = 0
  const errors: string[] = []

  for (const threshold of thresholds) {
    const chainId = dbChainToId(threshold.chain)

    try {
      const hotAddress = getHotWalletAddress(chainId)
      if (!hotAddress) {
        skipped++
        continue
      }

      const treasuryAddress = getTreasuryAddress(chainId)
      if (!treasuryAddress) {
        skipped++
        continue
      }

      // Look up the GasTreasuryWallet row for this chain's family.
      // EVM family is keyed by chain = ETH regardless of which EVM chain we're refilling.
      const representativeChain = (chainId === 'TRON' ? 'TRON' : 'ETH') as import('@prisma/client').GasChain
      const treasuryWallet = await db.gasTreasuryWallet.findUnique({
        where: { chain: representativeChain },
      })
      if (!treasuryWallet) {
        errors.push(`No GasTreasuryWallet DB row for ${chainId} — seed with POST /admin/gas/treasury/seed`)
        skipped++
        continue
      }

      // Already have a pending/approved/executing request for this chain?
      const existingRequest = await db.gasRefillRequest.findFirst({
        where: {
          chain:  threshold.chain,
          status: { in: ['pending_approval', 'approved', 'executing'] },
        },
      })
      if (existingRequest) {
        skipped++
        continue
      }

      const balance = await getHotWalletBalance(chainId, hotAddress)
      const triggerThreshold = Number(threshold.triggerBelowNative)

      if (balance >= triggerThreshold) {
        skipped++
        continue
      }

      // Compute refill amount: fill up to refillTargetNative, capped by maxRefillNative
      const deficit        = Number(threshold.refillTargetNative) - balance
      const refillAmount   = Math.min(deficit, Number(threshold.maxRefillNative))

      if (refillAmount <= 0) {
        skipped++
        continue
      }

      const usdPrice   = await getNativeUsdPrice(chainId).catch(() => 0)
      const usdAmount  = refillAmount * usdPrice
      const dbChain    = toDbChain(chainId)

      const nativeSymbolMap: Record<string, string> = {
        TRON: 'TRX', BSC: 'BNB', ETH: 'ETH', MATIC: 'POL',
        ARB: 'ETH', BASE: 'ETH', OP: 'ETH', AVAX: 'AVAX',
      }
      const symbol = nativeSymbolMap[threshold.chain] ?? threshold.chain

      await db.gasRefillRequest.create({
        data: {
          chain:          dbChain,
          fromWalletId:   treasuryWallet.id,
          fromAddress:    treasuryAddress,
          toAddress:      hotAddress,
          nativeAmount:   refillAmount,
          nativeSymbol:   symbol,
          usdAmount,
          triggerBalance: balance,
          status:         needsApproval ? 'pending_approval' : 'approved',
        },
      })

      log.info({ chain: chainId, balance, refillAmount, needsApproval }, 'Refill request queued')
      queued++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${chainId}: ${msg}`)
      log.error({ err, chain: chainId }, 'Error checking balance for refill')
    }
  }

  return { checked: thresholds.length, queued, skipped, errors }
}

// ── Execute a single approved refill ──────────────────────────────────────────

export async function executeRefill(refillId: string): Promise<void> {
  const request = await db.gasRefillRequest.findUnique({ where: { id: refillId } })
  if (!request) throw new Error(`Refill request ${refillId} not found`)
  if (request.status !== 'approved') {
    throw new Error(`Refill ${refillId} is not in approved state (current: ${request.status})`)
  }

  await db.gasRefillRequest.update({
    where: { id: refillId },
    data: { status: 'executing', executedAt: new Date() },
  })

  const chainId = fromDbChain(request.chain)
  let txHash: string

  try {
    txHash = await sendNativeFromTreasury(chainId, request.toAddress, Number(request.nativeAmount))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await db.gasRefillRequest.update({
      where: { id: refillId },
      data: {
        status:        'failed',
        failureReason: reason.slice(0, 500),
        retryCount:    { increment: 1 },
      },
    })
    throw err
  }

  await appendLedgerEntry({
    entryType:      'refill_hot_from_treasury',
    chain:          chainId,
    nativeAmount:   Number(request.nativeAmount),
    usdAmount:      Number(request.usdAmount),
    txHash,
    fromAddress:    request.fromAddress,
    toAddress:      request.toAddress,
    relatedRefillId: refillId,
    notes:          `Automated refill: ${request.nativeSymbol} treasury → hot wallet`,
  })

  await db.gasRefillRequest.update({
    where: { id: refillId },
    data: {
      status:      'completed',
      txHash,
      completedAt: new Date(),
    },
  })

  log.info({ refillId, txHash, chain: chainId, amount: Number(request.nativeAmount) }, 'Refill completed')
}

// ── Process all approved refills ───────────────────────────────────────────────

export async function processApprovedRefills(): Promise<{
  processed: number
  failed: number
  errors: string[]
}> {
  const approved = await db.gasRefillRequest.findMany({
    where: { status: 'approved' },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })

  let processed = 0
  let failed = 0
  const errors: string[] = []

  for (const req of approved) {
    try {
      await executeRefill(req.id)
      processed++
    } catch (err) {
      failed++
      errors.push(`${req.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { processed, failed, errors }
}

// ── Admin actions ──────────────────────────────────────────────────────────────

export async function approveRefill(refillId: string, adminUserId: string): Promise<void> {
  const request = await db.gasRefillRequest.findUnique({ where: { id: refillId } })
  if (!request) throw new Error(`Refill request ${refillId} not found`)
  if (request.status !== 'pending_approval') {
    throw new Error(`Cannot approve refill in status: ${request.status}`)
  }

  await db.gasRefillRequest.update({
    where: { id: refillId },
    data: { status: 'approved', approvedAt: new Date(), approvedBy: adminUserId },
  })
}

export async function cancelRefill(refillId: string, adminUserId: string): Promise<void> {
  const request = await db.gasRefillRequest.findUnique({ where: { id: refillId } })
  if (!request) throw new Error(`Refill request ${refillId} not found`)
  if (!['pending_approval', 'approved'].includes(request.status)) {
    throw new Error(`Cannot cancel refill in status: ${request.status}`)
  }

  await db.gasRefillRequest.update({
    where: { id: refillId },
    data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: adminUserId },
  })
}

// ── Crash recovery — reset stuck 'executing' requests ────────────────────────
// If the process dies between status=executing and tx completion, requests get
// stuck. We reset them to 'failed' after 30 minutes so the next threshold
// check can create a fresh request. We do NOT auto-retry to avoid double-send.

async function recoverStuckExecuting(): Promise<void> {
  const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000)
  const result = await db.gasRefillRequest.updateMany({
    where: { status: 'executing', executedAt: { lt: stuckCutoff } },
    data: {
      status: 'failed',
      failureReason: 'Process crash recovery: stuck in executing for >30 min. Check treasury balance manually.',
    },
  })
  if (result.count > 0) {
    log.warn({ count: result.count }, 'Reset stuck refill requests from executing → failed')
  }
}

// ── Combined job entrypoint (called by worker) ────────────────────────────────

export async function runRefillJob(): Promise<void> {
  // First: clean up any crash-stuck requests from previous runs
  await recoverStuckExecuting()

  // Second: check balances and queue new refills where needed
  log.info('Running refill job: checking balances...')
  const checkResult = await checkAndQueueRefills()
  log.info(checkResult, 'Refill check complete')

  // Third: always process approved refills — not just when new ones were queued.
  // Admin-approved refills must execute even if no new refills were triggered.
  log.info('Processing approved refills...')
  const execResult = await processApprovedRefills()
  if (execResult.processed > 0 || execResult.failed > 0) {
    log.info(execResult, 'Refill execution complete')
  }
}
