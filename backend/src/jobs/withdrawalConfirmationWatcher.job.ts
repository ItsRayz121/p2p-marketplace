/**
 * Withdrawal Confirmation Watcher
 *
 * Runs every 2 minutes. Scans Withdrawal rows in status='sent' that have a
 * txHash but no confirmed completedAt. For each:
 *   - EVM chains: calls eth_getTransactionReceipt to check if mined + status.
 *   - If confirmed (status 0x1, >= minConfirmations blocks): update to 'completed'.
 *   - If reverted (status 0x0): alert admin, mark 'on_hold' for manual review.
 *   - If older than MAX_PENDING_HOURS without a receipt: alert admin.
 *   - Aptos: polls fungible-asset tx finality directly (success → 'completed',
 *     failed → 'on_hold' + alert, pending → age-alert).
 *   - Other non-EVM (TRON etc.): only age-check; no on-chain polling yet.
 *
 * Also runs an orphan-recovery pass that re-drives auto-sends stuck in
 * 'auto_approved' with the balance already debited, and alerts once/day on any
 * that stay stuck past STUCK_ALERT_AGE_MS.
 */

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { getTransactionReceipt, getBlockNumber, EvmRpcError } from '../lib/evmRpc'
import { getChainByNetworkLabel, getRpcUrl } from '../services/chainRegistry.service'
import { createAdminNotif } from '../services/adminNotification.service'
import { recordAuditLog } from '../lib/audit'
import { isWellFormedEvmTxHash } from '../lib/txHash'
import { sendWithdrawalOnChain, evmWithdrawalClaimHeld } from '../lib/withdrawal.sender'
import { aptosWithdrawalClaimHeld } from '../lib/withdrawal.aptos.sender'
import { getAptosTxOutcome } from '../lib/gas/aptosTransfer'

// Alert if a sent withdrawal has no receipt after this many hours
const MAX_PENDING_HOURS = 2

// Re-drive auto-send for auto_approved withdrawals stuck this long. The initial
// send is fire-and-forget from requestWithdrawal; a process crash/redeploy mid-send
// (or a transient gas/RPC skip) can leave the row auto_approved forever with the
// balance already debited. This age gate avoids racing the original in-flight send.
const AUTO_SEND_RECOVERY_MIN_AGE_MS = 3 * 60 * 1000

// An auto_approved row with no txHash older than this is genuinely stuck (the
// initial send AND several recovery passes have failed). Alert admins once/day.
const STUCK_ALERT_AGE_MS = 15 * 60 * 1000

export async function runWithdrawalConfirmationWatcher(): Promise<void> {
  const cutoff = new Date(Date.now() - MAX_PENDING_HOURS * 3_600_000)

  // Recovery pass first — re-attempt any auto-send that never completed.
  await recoverOrphanedAutoSends().catch((err) =>
    logger.error({ err }, 'withdrawalConfirmationWatcher: auto-send recovery failed'),
  )

  // Find withdrawals that have been broadcast but not yet confirmed as complete
  const pending = await db.withdrawal.findMany({
    where: {
      status: 'sent',
      txHash: { not: null },
    },
    select: {
      id: true,
      orderRef: true,
      txHash: true,
      network: true,
      coin: true,
      amount: true,
      userId: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  })

  if (pending.length === 0) return

  logger.info({ count: pending.length }, 'withdrawalConfirmationWatcher: scanning sent withdrawals')

  for (const wd of pending) {
    try {
      await checkWithdrawal(wd, cutoff)
    } catch (err) {
      logger.error({ err, withdrawalId: wd.id }, 'withdrawalConfirmationWatcher: unexpected error')
    }
  }
}

async function checkWithdrawal(
  wd: { id: string; orderRef: string; txHash: string | null; network: string; coin: string; amount: object; userId: string; updatedAt: Date },
  staleCutoff: Date,
): Promise<void> {
  const txHash = wd.txHash!

  // Aptos: poll fungible-asset tx finality directly (no viem / RPC receipt).
  if (wd.network.toUpperCase() === 'APTOS') {
    await checkAptosWithdrawal(wd, staleCutoff)
    return
  }

  const chain = await getChainByNetworkLabel(wd.network)

  if (!chain || chain.family !== 'EVM') {
    // Non-EVM: only age-alert
    if (wd.updatedAt < staleCutoff) {
      await alertStaleWithdrawal(wd, 'non-EVM chain — confirm manually via explorer')
    }
    return
  }

  // A malformed hash can never resolve: the RPC rejects it as invalid params on every poll.
  // Don't re-ask the node every 2 minutes forever; tell an admin to fix the hash by hand.
  if (!isWellFormedEvmTxHash(txHash)) {
    await alertStaleWithdrawal(wd, 'the stored transaction hash is malformed — correct it from the explorer', true)
    return
  }

  const rpcUrl = getRpcUrl(chain.id)
  if (!rpcUrl) {
    if (wd.updatedAt < staleCutoff) {
      await alertStaleWithdrawal(wd, `no RPC URL for chain ${chain.id}`)
    }
    return
  }

  try {
    const [receipt, currentBlock] = await Promise.all([
      getTransactionReceipt(rpcUrl, chain.id, txHash),
      getBlockNumber(rpcUrl, chain.id),
    ])

    if (!receipt) {
      // Tx not yet mined
      if (wd.updatedAt < staleCutoff) {
        await alertStaleWithdrawal(wd, 'transaction not yet mined after 2+ hours — may be stuck or dropped')
      }
      return
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0

    if (receipt.status === '0x0') {
      // Tx reverted — this is a serious problem
      logger.error({ withdrawalId: wd.id, txHash, chain: chain.id }, 'withdrawalConfirmationWatcher: withdrawal tx REVERTED')
      await db.withdrawal.update({
        where: { id: wd.id },
        data: { status: 'on_hold', adminNote: `TX REVERTED on-chain: ${txHash}. Confirmations: ${confirmations}. Manual review required.` },
      })
      await recordAuditLog(wd.userId, 'WITHDRAWAL_TX_REVERTED', 'Withdrawal', wd.id, { txHash, chain: chain.id, confirmations })
      await createAdminNotif({
        category: 'WITHDRAWAL',
        title: `⚠ Withdrawal TX Reverted — ${wd.orderRef}`,
        body: `Withdrawal ${wd.orderRef} tx ${txHash.slice(0, 18)}… was REVERTED on-chain. Funds were NOT sent. Manual review required — may need to resend or refund user.`,
        href: `/admin/withdrawals`,
        metadata: { withdrawalId: wd.id, txHash, chain: chain.id },
      })
      return
    }

    // Tx mined and successful
    if (confirmations >= chain.minConfirmations) {
      await db.withdrawal.update({
        where: { id: wd.id, status: 'sent' }, // guard against concurrent update
        data: { status: 'completed', completedAt: new Date() },
      })
      await recordAuditLog(wd.userId, 'WITHDRAWAL_CONFIRMED', 'Withdrawal', wd.id, { txHash, chain: chain.id, confirmations })
      logger.info({ withdrawalId: wd.id, txHash, confirmations }, 'withdrawalConfirmationWatcher: withdrawal confirmed')
    } else {
      logger.debug({ withdrawalId: wd.id, txHash, confirmations, needed: chain.minConfirmations }, 'withdrawalConfirmationWatcher: waiting for confirmations')
    }
  } catch (err) {
    if (err instanceof EvmRpcError) {
      logger.warn({ err: err.message, withdrawalId: wd.id, chain: chain.id }, 'withdrawalConfirmationWatcher: RPC error')
      // A node that keeps erroring must not hide a withdrawal that has been stuck for hours.
      if (wd.updatedAt < staleCutoff) {
        await alertStaleWithdrawal(wd, `chain RPC keeps returning an error (${err.message.slice(0, 80)})`)
      }
      return
    }
    throw err
  }
}

/**
 * Aptos confirmation: the fungible-asset transfer hash is looked up directly on
 * the fullnode. Deterministic BFT finality — a committed tx is final, so there
 * is no confirmation count to wait on.
 *   - success  → withdrawal 'completed'
 *   - failed   → withdrawal 'on_hold' + admin alert (funds did NOT move)
 *   - pending  → age-alert only (same 2h threshold as EVM)
 */
async function checkAptosWithdrawal(
  wd: { id: string; orderRef: string; txHash: string | null; network: string; coin: string; amount: object; userId: string; updatedAt: Date },
  staleCutoff: Date,
): Promise<void> {
  const txHash = wd.txHash!
  const outcome = await getAptosTxOutcome(txHash)

  if (outcome === 'success') {
    await db.withdrawal.update({
      where: { id: wd.id, status: 'sent' }, // guard against concurrent update
      data: { status: 'completed', completedAt: new Date() },
    })
    await recordAuditLog(wd.userId, 'WITHDRAWAL_CONFIRMED', 'Withdrawal', wd.id, { txHash, chain: 'aptos' })
    logger.info({ withdrawalId: wd.id, txHash }, 'withdrawalConfirmationWatcher: Aptos withdrawal confirmed')
    return
  }

  if (outcome === 'failed') {
    logger.error({ withdrawalId: wd.id, txHash }, 'withdrawalConfirmationWatcher: Aptos withdrawal tx FAILED')
    await db.withdrawal.update({
      where: { id: wd.id },
      data: { status: 'on_hold', adminNote: `Aptos TX FAILED on-chain: ${txHash}. Funds did not move. Manual review required — resend or refund.` },
    })
    await recordAuditLog(wd.userId, 'WITHDRAWAL_TX_REVERTED', 'Withdrawal', wd.id, { txHash, chain: 'aptos' })
    await createAdminNotif({
      category: 'WITHDRAWAL',
      title: `⚠ Aptos Withdrawal TX Failed — ${wd.orderRef}`,
      body: `Withdrawal ${wd.orderRef} tx ${txHash.slice(0, 18)}… FAILED on-chain. Funds were NOT sent. Manual review required — resend from the hot wallet or Reject to refund.`,
      href: `/admin/withdrawals`,
      metadata: { withdrawalId: wd.id, txHash, chain: 'aptos' },
    })
    return
  }

  // pending — not yet committed
  if (wd.updatedAt < staleCutoff) {
    await alertStaleWithdrawal(wd, 'Aptos transaction not yet committed after 2+ hours — check the explorer')
  }
}

/**
 * Re-drive auto-send for withdrawals stuck in 'auto_approved'. Both senders re-read the row
 * inside the hot-wallet lock and take a Redis claim before broadcasting (and finalizeWithdrawalSent
 * claims the row with updateMany({status:'auto_approved'})), so this must not double-broadcast a
 * withdrawal that is in flight or already went out. Per-chain hot-wallet locking (hotWalletLock.ts) prevents nonce clashes
 * with concurrent sends.
 */
async function recoverOrphanedAutoSends(): Promise<void> {
  const ageCutoff = new Date(Date.now() - AUTO_SEND_RECOVERY_MIN_AGE_MS)
  const orphans = await db.withdrawal.findMany({
    where: {
      status: 'auto_approved',
      txHash: null,
      createdAt: { lt: ageCutoff },
    },
    select: {
      id: true,
      orderRef: true,
      userId: true,
      coin: true,
      network: true,
      amount: true,
      fee: true,
      toAddress: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })

  if (orphans.length === 0) return

  logger.warn({ count: orphans.length }, 'withdrawalConfirmationWatcher: recovering orphaned auto_approved withdrawals')

  for (const wd of orphans) {
    // If an Aptos send is mid-flight (broadcast, awaiting DB finalize) its claim
    // key is held — don't race a second broadcast against it.
    if (wd.network.toUpperCase() === 'APTOS' && (await aptosWithdrawalClaimHeld(wd.id).catch(() => false))) {
      logger.info({ withdrawalId: wd.id }, 'withdrawalConfirmationWatcher: Aptos send in flight, skipping recovery')
      continue
    }

    // Same for EVM: a send that is mid-flight (or crashed after broadcast) holds a claim. Never
    // re-broadcast against it; the stuck alert below tells an admin to look.
    const evmHeld = wd.network.toUpperCase() !== 'APTOS' && (await evmWithdrawalClaimHeld(wd.id).catch(() => false))

    // Genuinely stuck (initial send + earlier recovery passes all failed) → alert
    // admins once per day so it can't sit invisible with the balance debited.
    if (Date.now() - wd.createdAt.getTime() > STUCK_ALERT_AGE_MS) {
      await alertStuckAutoApproved({
        id: wd.id,
        orderRef: wd.orderRef,
        coin: wd.coin,
        network: wd.network,
        amount: wd.amount.toString(),
      }).catch((err) =>
        logger.error({ err, withdrawalId: wd.id }, 'withdrawalConfirmationWatcher: stuck alert failed'),
      )
    }

    if (evmHeld) {
      logger.info({ withdrawalId: wd.id }, 'withdrawalConfirmationWatcher: EVM send claim held, skipping recovery')
      continue
    }

    try {
      await sendWithdrawalOnChain({
        id: wd.id,
        userId: wd.userId,
        coin: wd.coin,
        network: wd.network,
        amount: wd.amount.toString(),
        fee: wd.fee.toString(),
        toAddress: wd.toAddress,
      })
    } catch (err) {
      logger.error({ err, withdrawalId: wd.id }, 'withdrawalConfirmationWatcher: recovery send threw')
    }
  }
}

/** Alert admins about a stuck auto_approved withdrawal — deduped to once per 24h. */
async function alertStuckAutoApproved(wd: {
  id: string
  orderRef: string
  coin: string
  network: string
  amount: string
}): Promise<void> {
  const flag = `withdrawal:stuck:alerted:${wd.id}`
  const first = await redis.set(flag, '1', 'EX', 86_400, 'NX')
  if (first !== 'OK') return // already alerted within the last day

  logger.warn({ withdrawalId: wd.id, orderRef: wd.orderRef }, 'withdrawalConfirmationWatcher: auto_approved withdrawal STUCK')
  await createAdminNotif({
    category: 'WITHDRAWAL',
    title: `Withdrawal Stuck in Sending — ${wd.orderRef}`,
    body: `Withdrawal ${wd.orderRef} (${wd.amount} ${wd.coin} on ${wd.network}) has been auto-approved with the balance debited but no on-chain send for 15+ minutes. Auto-retry keeps failing. Check admin notifications for the cause, then Mark Sent (Manual Fallback) after sending — or Reject to refund.`,
    href: `/admin/withdrawals`,
    metadata: { withdrawalId: wd.id, orderRef: wd.orderRef, network: wd.network },
  })
}

// One alert per withdrawal per window. The watcher runs every 2 minutes, so without this a single
// stuck withdrawal raised a fresh admin notification on every tick.
const STALE_ALERT_WINDOW_SECONDS = 6 * 3600
// A malformed stored hash never fixes itself, so re-alerting every 6h is just noise: remind weekly.
const MALFORMED_ALERT_WINDOW_SECONDS = 7 * 86_400

async function alertStaleWithdrawal(
  wd: { id: string; orderRef: string; txHash: string | null; network: string; updatedAt: Date },
  reason: string,
  immediate = false,
): Promise<void> {
  // `immediate` is for conditions that are wrong on arrival (malformed hash), not merely old.
  if (!immediate && wd.updatedAt >= new Date(Date.now() - 2 * 3_600_000)) return
  const first = await redis
    .set(`wd:stale-alert:${wd.id}`, '1', 'EX', immediate ? MALFORMED_ALERT_WINDOW_SECONDS : STALE_ALERT_WINDOW_SECONDS, 'NX')
    .catch(() => 'OK') // Redis down: alert rather than stay silent
  if (first !== 'OK') return
  logger.warn({ withdrawalId: wd.id, reason }, 'withdrawalConfirmationWatcher: stale withdrawal')
  await createAdminNotif({
    category: 'WITHDRAWAL',
    title: `Withdrawal Stuck — ${wd.orderRef}`,
    body: `Withdrawal ${wd.orderRef} is in status=sent and needs attention${immediate ? '' : ' (2+ hours)'}. Reason: ${reason}. Tx: ${wd.txHash?.slice(0, 18)}… Network: ${wd.network}`,
    href: `/admin/withdrawals`,
    metadata: { withdrawalId: wd.id, txHash: wd.txHash, network: wd.network },
  })
}
