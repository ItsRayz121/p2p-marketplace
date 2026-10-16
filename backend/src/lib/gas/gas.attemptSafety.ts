import type { GasFeeOrder } from '@prisma/client'
import { db } from '../prisma'
import { logger } from '../logger'
import { getTransactionCount } from '../evmRpc'
import { getTxStatus, isEvmGasChain, evmRpcFor } from './gas.confirmation'
import {
  classifyPriorAttempt, describePriorAttempt,
  type ObservedTxState, type PriorAttemptVerdict,
} from './gas.attemptRules'

export interface PriorAttemptAssessment {
  verdict: PriorAttemptVerdict
  txHash: string | null
  detail: string
}

type OrderFacts = Pick<GasFeeOrder,
  'chain' | 'unconfirmedDeliveryTxHash' | 'deliveryNonce' | 'deliveryAttemptAt' | 'fromHotWallet'>

/**
 * Live, read-only check of whether an earlier delivery broadcast for this order can still
 * pay the customer. Fails CLOSED: any error reading the chain yields 'unresolved'.
 */
export async function assessPriorAttempt(order: OrderFacts): Promise<PriorAttemptAssessment> {
  const txHash = order.unconfirmedDeliveryTxHash
  if (!txHash) return { verdict: 'none', txHash: null, detail: describePriorAttempt('none') }

  const evm = isEvmGasChain(order.chain)

  // EVM proof input: read the sender's CONFIRMED tx count FIRST, then the tx status — if our
  // own tx got mined in between, the status lookup then sees it and wins over the nonce proof.
  let senderConfirmedCount: number | null = null
  if (evm && order.deliveryNonce !== null && order.fromHotWallet) {
    try {
      const rpc = await evmRpcFor(order.chain)
      if (rpc) senderConfirmedCount = await getTransactionCount(rpc.url, rpc.key, order.fromHotWallet, 'latest')
    } catch (err) {
      logger.warn({ err, chain: order.chain }, 'assessPriorAttempt: sender nonce read failed — treating as unresolved')
    }
  }

  let state: ObservedTxState
  try {
    state = (await getTxStatus(order.chain, txHash)).state
  } catch (err) {
    logger.warn({ err, chain: order.chain, txHash }, 'assessPriorAttempt: status lookup failed — treating as unresolved')
    state = 'unreachable'
  }

  const verdict = classifyPriorAttempt({
    hasAttempt: true,
    chain: order.chain,
    evm,
    state,
    nonce: order.deliveryNonce,
    senderConfirmedCount,
    attemptAgeMs: order.deliveryAttemptAt ? Date.now() - order.deliveryAttemptAt.getTime() : null,
  })
  return { verdict, txHash, detail: describePriorAttempt(verdict, txHash) }
}

/**
 * The earlier broadcast landed. Hand the order back (failed / awaiting_refund / refund_pending
 * → sending) to the delivery verifier so it is finalised as delivered with all side-effects —
 * and never resent or refunded. Returns true if this call performed the hand-back.
 */
export async function handBackLandedDelivery(orderId: string, txHash: string): Promise<boolean> {
  const { queues } = await import('../../queues/definitions')
  const moved = await db.gasFeeOrder.updateMany({
    where: { id: orderId, deliveryTxHash: null, status: { in: ['failed', 'awaiting_refund', 'refund_pending', 'payment_detected'] } },
    data: { status: 'sending' },
  })
  if (moved.count === 0) return false
  await queues.gasFee.add(
    'verify-delivery',
    { orderId, txHash, startedAt: Date.now() },
    { jobId: `gas-verify-handback-${orderId}-${Date.now()}`, attempts: 1 },
  )
  // The safety-net refund and any retry chain must not fire for an order that was paid out.
  try { await queues.gasFee.remove(`gas-auto-refund-${orderId}`) } catch { /* non-fatal */ }
  return true
}
