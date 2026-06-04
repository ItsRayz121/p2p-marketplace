/**
 * Withdrawal Confirmation Watcher
 *
 * Runs every 2 minutes. Scans Withdrawal rows in status='sent' that have a
 * txHash but no confirmed completedAt. For each:
 *   - EVM chains: calls eth_getTransactionReceipt to check if mined + status.
 *   - If confirmed (status 0x1, >= minConfirmations blocks): update to 'completed'.
 *   - If reverted (status 0x0): alert admin, mark 'on_hold' for manual review.
 *   - If older than MAX_PENDING_HOURS without a receipt: alert admin.
 *   - Non-EVM (TRON etc.): only age-check; no on-chain polling yet.
 */

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { getTransactionReceipt, getBlockNumber, EvmRpcError } from '../lib/evmRpc'
import { getChainByNetworkLabel, getRpcUrl } from '../services/chainRegistry.service'
import { createAdminNotif } from '../services/adminNotification.service'
import { sendAdminAlertEmail } from '../services/email.service'
import { recordAuditLog } from '../lib/audit'

// Alert if a sent withdrawal has no receipt after this many hours
const MAX_PENDING_HOURS = 2

export async function runWithdrawalConfirmationWatcher(): Promise<void> {
  const cutoff = new Date(Date.now() - MAX_PENDING_HOURS * 3_600_000)

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
  const chain = await getChainByNetworkLabel(wd.network)

  if (!chain || chain.family !== 'EVM') {
    // Non-EVM: only age-alert
    if (wd.updatedAt < staleCutoff) {
      await alertStaleWithdrawal(wd, 'non-EVM chain — confirm manually via explorer')
    }
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
        category: 'SYSTEM',
        title: `⚠ Withdrawal TX Reverted — ${wd.orderRef}`,
        body: `Withdrawal ${wd.orderRef} tx ${txHash.slice(0, 18)}… was REVERTED on-chain. Funds were NOT sent. Manual review required — may need to resend or refund user.`,
        href: `/admin/withdrawals`,
        metadata: { withdrawalId: wd.id, txHash, chain: chain.id },
      })
      await sendAdminAlertEmail(
        `URGENT: Withdrawal TX Reverted — ${wd.orderRef}`,
        `Withdrawal ${wd.orderRef}\nUser: ${wd.userId}\nAmount: ${wd.amount}\nTx: ${txHash}\nChain: ${chain.id}\n\nThe on-chain transaction was reverted. The user did NOT receive funds. Investigate and either resend or refund.`,
      ).catch(() => {})
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
      return
    }
    throw err
  }
}

async function alertStaleWithdrawal(
  wd: { id: string; orderRef: string; txHash: string | null; network: string; updatedAt: Date },
  reason: string,
): Promise<void> {
  logger.warn({ withdrawalId: wd.id, reason }, 'withdrawalConfirmationWatcher: stale withdrawal')
  await createAdminNotif({
    category: 'SYSTEM',
    title: `Withdrawal Stuck — ${wd.orderRef}`,
    body: `Withdrawal ${wd.orderRef} has been in status=sent for 2+ hours. Reason: ${reason}. Tx: ${wd.txHash?.slice(0, 18)}… Network: ${wd.network}`,
    href: `/admin/withdrawals`,
    metadata: { withdrawalId: wd.id, txHash: wd.txHash, network: wd.network },
  })
}
