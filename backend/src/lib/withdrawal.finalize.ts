/**
 * Shared post-broadcast finalize for auto-sent withdrawals.
 *
 * Both the EVM sender (withdrawal.sender.ts) and the Aptos sender
 * (withdrawal.aptos.sender.ts) call this AFTER the on-chain transfer has been
 * broadcast + confirmed, so the DB bookkeeping, fee ledger entry and success
 * notification stay identical across chains.
 *
 * Idempotent: the withdrawal row is claimed with updateMany({status:'auto_approved'})
 * before anything else — a concurrent admin/worker that already moved it is a no-op.
 */

import { db } from './prisma'
import { logger as log } from './logger'
import { createAdminNotif } from '../services/adminNotification.service'
import { appendLedgerEntry } from './gas/gas.ledger'
import { paymentNetworkSettlementChain } from './gas/gas.chains'
import type { GasChainId } from './gas/gas.chains'

// Withdrawal network label → GasChainId for the platform_fee ledger entry.
// TRC20/BEP20/ERC20/APTOS are also covered by paymentNetworkSettlementChain()
// (via chainOverride); this map adds the L2s that helper does not know about.
const NETWORK_TO_GAS_CHAIN: Partial<Record<string, GasChainId>> = {
  TRC20: 'TRON',
  BEP20: 'BSC',
  ERC20: 'ETHEREUM',
  BASE: 'BASE',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  POLYGON: 'MATIC',
}

export interface FinalizeWithdrawalInput {
  id: string
  userId: string
  coin: string
  network: string
  amount: number | string
  fee?: number | string
}

/**
 * Mark an auto-approved withdrawal as sent, complete its pending Transaction,
 * record the platform fee in the gas ledger, and notify admins.
 *
 * Returns true when THIS call claimed and finalized the row, false when the row
 * had already been moved on by someone else (nothing to do).
 */
export async function finalizeWithdrawalSent(
  wd: FinalizeWithdrawalInput,
  txHash: string,
): Promise<boolean> {
  const wallet = await db.wallet.findFirst({
    where: { userId: wd.userId, coin: wd.coin, network: wd.network },
    select: { id: true },
  })

  const claimed = await db.$transaction(async (tx) => {
    const locked = await tx.withdrawal.updateMany({
      where: { id: wd.id, status: 'auto_approved' },
      data: { status: 'sent', txHash, completedAt: new Date() },
    })
    if (locked.count === 0) return false // already processed concurrently

    if (wallet) {
      const pendingTx = await tx.transaction.findFirst({
        where: {
          walletId: wallet.id,
          type: 'withdrawal',
          status: 'pending',
          metadata: { path: ['withdrawalId'], equals: wd.id },
        },
      })
      if (pendingTx) {
        await tx.transaction.update({
          where: { id: pendingTx.id },
          data: { status: 'completed', txHash },
        })
      }
    }
    return true
  })

  if (!claimed) {
    log.info({ withdrawalId: wd.id, txHash }, 'finalizeWithdrawalSent: row already moved on, skipping')
    return false
  }

  log.info(
    { withdrawalId: wd.id, txHash, coin: wd.coin, network: wd.network },
    'Auto-send withdrawal completed',
  )

  // Record the platform fee in the gas ledger. The fee stays physically in the
  // hot wallet (only `amount` is sent on-chain, not amount+fee); this entry makes
  // it traceable in revenue accounting.
  const feeAmount = Number(wd.fee ?? 0)
  if (feeAmount > 0) {
    const net = wd.network.toUpperCase()
    const settle = paymentNetworkSettlementChain(net) // TRC20/BEP20/ERC20/APTOS
    const evmGasChain = NETWORK_TO_GAS_CHAIN[net]     // L2s not covered by settle
    if (settle || evmGasChain) {
      void appendLedgerEntry({
        entryType: 'platform_fee',
        // chainOverride is authoritative when set; `chain` is only a type-level
        // fallback + live-price key, and price lookup is skipped (usdAmount given).
        chain: evmGasChain ?? 'BSC',
        ...(settle ? { chainOverride: settle } : {}),
        nativeAmount: 0, // no native movement — fee is in token
        tokenSymbol: wd.coin.toUpperCase(),
        tokenAmount: feeAmount,
        usdAmount: feeAmount, // USDT ≈ 1 USD
        txHash,
        sourceKey: `platform_fee:withdrawal:${wd.id}`,
        notes: `Withdrawal fee from user ${wd.userId} — withdrawal ${wd.id}`,
      }).catch((err) => log.error({ err, withdrawalId: wd.id }, 'Failed to write platform_fee ledger entry'))
    }
  }

  const userRow = await db.user
    .findUnique({ where: { id: wd.userId }, select: { username: true } })
    .catch(() => null)
  const userLabel = userRow?.username ?? wd.userId.slice(-8)
  void createAdminNotif({
    category: 'WITHDRAWAL',
    title: `Withdrawal Sent: ${wd.amount} ${wd.coin}`,
    body: `User ${userLabel} auto-withdrawal of ${wd.amount} ${wd.coin} (${wd.network}) sent on-chain. TX: ${txHash.slice(0, 18)}...`,
    href: '/admin/withdrawals?tab=sent',
    metadata: {
      withdrawalId: wd.id,
      txHash,
      coin: wd.coin,
      amount: String(wd.amount),
      network: wd.network,
      userId: wd.userId,
    },
  })

  return true
}
