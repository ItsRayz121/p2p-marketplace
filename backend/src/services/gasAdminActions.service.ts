import { db } from '../lib/prisma'
import { queues } from '../queues/definitions'
import { AppError, Errors } from '../lib/errors'
import { notify } from '../lib/notify'
import { MANUAL_PROOF_WHERE, PAID_FAILED_WHERE, REJECTABLE_STATUS } from '../lib/gas/gas.orderStates'

/**
 * The money-moving admin actions on a gas order, in ONE place, so the admin website and the Telegram
 * buttons run exactly the same checks. Each action is a compare-and-set on the order status, so two
 * admins (or a double tap, or a website click racing a Telegram tap) can never run it twice.
 *
 * None of these send anything on-chain themselves: approve and retry only queue the delivery worker,
 * which has its own no-double-delivery guards (gas.attemptSafety).
 */

export interface AdminActor {
  id: string
  /** Where the click came from, recorded in the audit trail. */
  via: 'web' | 'telegram'
  ip?: string | undefined
  userAgent?: string | undefined
}

async function audit(actor: AdminActor, action: string, orderId: string, details: Record<string, unknown>) {
  await db.auditLog.create({
    data: {
      actorId: actor.id,
      action,
      targetType: 'GasFeeOrder',
      targetId: orderId,
      metadata: { ...details, via: actor.via },
      ipAddress: actor.ip ?? null,
      userAgent: actor.userAgent ? actor.userAgent.slice(0, 500) : null,
    },
  })
}

/** Approve a PKR / exchange-transfer payment that is waiting for review: queues the gas delivery. */
export async function approveManualGasPayment(id: string, actor: AdminActor): Promise<{ status: 'payment_detected'; orderRef: string }> {
  // Read first so we can check expiry before queuing delivery
  const order = await db.gasFeeOrder.findUnique({ where: { id } })
  if (!order) throw Errors.NOT_FOUND('Gas fee order')

  // Manual-proof orders: PKR transfers and exchange (internal USDT) transfers.
  if (order.status !== 'payment_uploaded' || !(order.paymentCoin === 'PKR' || order.paymentNetwork === 'EXCHANGE')) {
    throw new AppError('CONFLICT', `Order is in '${order.status}' — can only approve payment_uploaded PKR or exchange-transfer orders`, 409)
  }

  if (order.expiresAt < new Date()) {
    throw new AppError('ORDER_EXPIRED', 'Order has expired. The user must create a new order.', 409)
  }

  // CAS: transition payment_uploaded → payment_detected (guards against race with another admin)
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id, status: 'payment_uploaded', ...MANUAL_PROOF_WHERE },
    data: { status: 'payment_detected' },
  })
  if (claimed.count === 0) {
    throw new AppError('CONFLICT', 'Order was already processed by another admin', 409)
  }
  await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
  await audit(actor, 'GAS_PKR_APPROVED', id, {
    orderRef: order.orderRef,
    oldStatus: 'payment_uploaded',
    newStatus: 'payment_detected',
    paymentCoin: order.paymentCoin,
    pkrAmount: order.pkrAmount?.toString() ?? null,
  })
  return { status: 'payment_detected', orderRef: order.orderRef }
}

/**
 * Reject a submitted payment proof. The order moves to the terminal 'cancelled' state — NOT 'failed' —
 * so it can never be picked up by Retry Delivery or offered a refund for a payment that was never
 * accepted. Nothing is delivered or sent.
 */
export async function rejectManualGasPayment(id: string, rawReason: string | undefined, actor: AdminActor): Promise<{ status: 'cancelled'; orderRef: string }> {
  const reason = (typeof rawReason === 'string' ? rawReason.trim() : '').slice(0, 300) || 'Payment proof rejected by admin'

  const order = await db.gasFeeOrder.findUnique({ where: { id }, select: { id: true, orderRef: true, status: true, paymentCoin: true, paymentNetwork: true, userId: true } })
  if (!order) throw Errors.NOT_FOUND('Gas fee order')

  const claimed = await db.gasFeeOrder.updateMany({
    where: { id, status: REJECTABLE_STATUS, ...MANUAL_PROOF_WHERE },
    data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: `admin_rejected: ${reason}`, failureReason: reason },
  })
  if (claimed.count === 0) {
    const fresh = await db.gasFeeOrder.findUnique({ where: { id }, select: { status: true } })
    throw new AppError('CONFLICT', `Order is in '${fresh?.status ?? order.status}' — only a PKR or exchange-transfer order with a submitted proof can be rejected.`, 409)
  }
  // The 24h expiry job is moot now.
  try { await queues.gasFee.remove(`gas-expire-${id}`) } catch { /* non-fatal */ }
  const { recordGasAudit } = await import('../lib/gas/gas.matching')
  await recordGasAudit({ orderId: id }, { source: 'admin', event: 'proof_rejected', reason, detail: `Rejected by admin ${actor.id} (${actor.via})` })
  await audit(actor, 'GAS_PKR_REJECTED', id, {
    orderRef: order.orderRef, oldStatus: order.status, newStatus: 'cancelled', paymentNetwork: order.paymentNetwork, reason,
  })
  if (order.userId) {
    notify(order.userId, 'gas', 'Gas payment not verified', `We could not verify the payment for order ${order.orderRef}: ${reason}. No gas was sent and the order was closed.`, { orderRef: order.orderRef })
  }
  return { status: 'cancelled', orderRef: order.orderRef }
}

/**
 * Re-queue the delivery of a failed or stuck order. STRICT no-double-delivery gate: if an earlier
 * delivery tx was ever broadcast, Retry is only allowed once that attempt is PROVEN unable to land.
 * A landed one is adopted instead.
 */
export async function retryGasDelivery(id: string, actor: AdminActor): Promise<{ message?: string }> {
  const pre = await db.gasFeeOrder.findUnique({ where: { id } })
  if (!pre) throw Errors.NOT_FOUND('Gas fee order')
  if (pre.unconfirmedDeliveryTxHash) {
    const { assessPriorAttempt, handBackLandedDelivery } = await import('../lib/gas/gas.attemptSafety')
    const prior = await assessPriorAttempt(pre)
    if (prior.verdict === 'landed' && prior.txHash) {
      await handBackLandedDelivery(id, prior.txHash)
      await audit(actor, 'GAS_ORDER_RETRY_BLOCKED_LANDED', id, { txHash: prior.txHash })
      return { message: 'The earlier delivery transaction had actually landed on-chain — the order is being finalized as delivered. Nothing was resent.' }
    }
    if (prior.verdict === 'unresolved') {
      throw new AppError('CONFLICT', `Retry blocked to prevent a double delivery. ${prior.detail} Wait and use "Verify on-chain", or deliver manually only after confirming the earlier tx cannot land.`, 409)
    }
    // dead: archive the proven-dead attempt in the audit trail, then clear the journal so the worker may send once more.
    await audit(actor, 'GAS_ORDER_RETRY_AFTER_PROVEN_DEAD', id, { deadTxHash: prior.txHash, nonce: pre.deliveryNonce, detail: prior.detail })
    await db.gasFeeOrder.updateMany({
      where: { id, unconfirmedDeliveryTxHash: pre.unconfirmedDeliveryTxHash },
      data: { unconfirmedDeliveryTxHash: null, deliveryNonce: null, deliveryAttemptAt: null },
    })
  }

  // CAS: transition failed/awaiting_refund → payment_detected so the delivery
  // worker can re-claim it. For awaiting_refund we also clear the refund window.
  // Concurrent retries find count=0 on the second call and fall through below.
  // A 'failed' order is only retryable when payment was actually accepted
  // (PAID_FAILED_WHERE) — never a rejected/cancelled proof.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id, deliveryTxHash: null, OR: [{ status: 'awaiting_refund' }, PAID_FAILED_WHERE] },
    data: { status: 'payment_detected', failureReason: null, refundEligibleAt: null, retryCount: { increment: 1 } },
  })

  let previousStatus = 'failed'
  if (claimed.count === 0) {
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    // An order paused on insufficient hot-wallet balance sits in payment_detected
    // (not failed). After the admin refills the wallet, "Retry" simply re-enqueues
    // the delivery job — the order is already in the claimable state.
    if (order.status === 'payment_detected') {
      previousStatus = 'payment_detected'
      await db.gasFeeOrder.update({ where: { id }, data: { failureReason: null } })
    } else {
      throw new AppError('CONFLICT', order.status === 'failed'
        ? 'This order never had a payment accepted (rejected or cancelled) — it cannot be retried.'
        : `Order is in '${order.status}' — only failed, stuck (payment_detected), or awaiting_refund orders can be retried`, 409)
    }
  } else {
    // Came from awaiting_refund (or failed): drop the pending safety-net auto-refund
    // so it can't fire after a manual retry. The retry-delivery chain self-stops.
    try { await queues.gasFee.remove(`gas-auto-refund-${id}`) } catch { /* non-fatal */ }
  }

  await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
  await audit(actor, 'GAS_ORDER_RETRY', id, { previousStatus, oldStatus: previousStatus, newStatus: 'payment_detected' })
  return {}
}
