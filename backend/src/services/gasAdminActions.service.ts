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

// ── Ethereum "Speed up" ──────────────────────────────────────────────────────

const ETH_SEND_GAS = 21_000
const WEI = 1e18

export interface EthRetryStep {
  label: string
  maxFeeGwei: number
  /** Worst-case network cost of this tx (max fee x 21,000 gas), in USD. */
  maxCostUsd: number
  /** Platform margin left if the tx pays its worst-case fee. */
  marginUsd: number
}
export interface EthRetryPlan {
  marginBeforeNetworkCostUsd: number
  speedUpsDone: number
  speedUpsMax: number
  steps: EthRetryStep[]
}

/**
 * What an Ethereum order earns and what each further speed-up could cost, so the admin sees the margin
 * shrinking BEFORE pressing the button. Worst case = the tx pays its full max fee (it normally pays less).
 * Null when the stuck tx's fee can no longer be read from any node.
 */
export async function getEthRetryPlan(order: { id: string; chain: string; unconfirmedDeliveryTxHash: string | null; platformMarginUsdt: unknown; priceAtOrder: unknown }): Promise<EthRetryPlan | null> {
  if (order.chain !== 'ETH' || !order.unconfirmedDeliveryTxHash) return null
  const { readStuckTxFees, bumpedFees, SPEEDUP_MAX_STEPS } = await import('../lib/gas/gas.delivery')
  const prev = await readStuckTxFees(order.chain, order.unconfirmedDeliveryTxHash)
  if (!prev) return null
  const ethUsd = Number(order.priceAtOrder)
  const margin = Number(order.platformMarginUsdt ?? 0)
  const done = await db.auditLog.count({ where: { targetType: 'GasFeeOrder', targetId: order.id, action: 'GAS_DELIVERY_SPEEDUP' } })
  const cost = (maxFee: bigint) => (ETH_SEND_GAS * Number(maxFee)) / WEI * ethUsd
  const steps: EthRetryStep[] = []
  let cur = prev
  steps.push({ label: done === 0 ? 'Current transaction' : `Current (speed-up ${done})`, maxFeeGwei: Number(cur.maxFeePerGas) / 1e9, maxCostUsd: cost(cur.maxFeePerGas), marginUsd: margin - cost(cur.maxFeePerGas) })
  for (let n = done + 1; n <= SPEEDUP_MAX_STEPS; n++) {
    cur = { ...cur, ...bumpedFees(cur) }
    steps.push({ label: `Speed-up ${n} (+11%)`, maxFeeGwei: Number(cur.maxFeePerGas) / 1e9, maxCostUsd: cost(cur.maxFeePerGas), marginUsd: margin - cost(cur.maxFeePerGas) })
  }
  return { marginBeforeNetworkCostUsd: margin, speedUpsDone: done, speedUpsMax: SPEEDUP_MAX_STEPS, steps }
}

/**
 * Ethereum only. Re-send the stuck payout under the SAME nonce with +11% fee. No extra transaction is
 * spent (the replacement is the delivery) and a double delivery is impossible: one nonce, one winner,
 * and every replaced hash is kept (audit log) so a late-landing earlier one is still adopted.
 */
export async function speedUpStuckDelivery(id: string, actor: AdminActor): Promise<{ message: string; txHash?: string }> {
  const order = await db.gasFeeOrder.findUnique({ where: { id } })
  if (!order) throw Errors.NOT_FOUND('Gas fee order')
  if (order.chain !== 'ETH') throw new AppError('CONFLICT', 'Speed up is only available for Ethereum orders.', 409)
  if (order.gasTokenConfigId) {
    const cfg = await db.gasTokenConfig.findUnique({ where: { id: order.gasTokenConfigId }, select: { tokenType: true } })
    if (cfg && cfg.tokenType !== 'native') throw new AppError('CONFLICT', 'Speed up only supports native ETH deliveries.', 409)
  }
  if (order.deliveryTxHash || !order.unconfirmedDeliveryTxHash) throw new AppError('CONFLICT', 'This order has no stuck delivery transaction.', 409)
  if (order.status !== 'failed') throw new AppError('CONFLICT', `Order is '${order.status}' — speed up is offered once the delivery is reported stuck (failed).`, 409)

  const { SPEEDUP_MAX_STEPS, speedUpEvmDelivery } = await import('../lib/gas/gas.delivery')
  const done = await db.auditLog.count({ where: { targetType: 'GasFeeOrder', targetId: id, action: 'GAS_DELIVERY_SPEEDUP' } })
  if (done >= SPEEDUP_MAX_STEPS) {
    throw new AppError('CONFLICT', `Already sped up ${done} times (about +23%) — the fee cap is reached. Use "Cancel stuck tx", then deliver manually.`, 409)
  }

  const { assessPriorAttempt, handBackLandedDelivery } = await import('../lib/gas/gas.attemptSafety')
  const prior = await assessPriorAttempt(order)
  if (prior.verdict === 'landed' && prior.txHash) {
    await handBackLandedDelivery(id, prior.txHash)
    return { message: 'The delivery had actually landed on-chain — the order is being finalized as delivered. Nothing was resent.' }
  }
  if (prior.verdict === 'dead') return { message: 'The earlier transaction is already proven dead — use the normal Retry instead.' }
  if (prior.verdict === 'none') throw new AppError('CONFLICT', 'No earlier attempt found.', 409)

  // Claim the order (failed -> sending) so a concurrent click, refund or retry cannot race this send.
  const claimed = await db.gasFeeOrder.updateMany({ where: { id, status: 'failed', deliveryTxHash: null }, data: { status: 'sending', failureReason: null } })
  if (claimed.count === 0) throw new AppError('CONFLICT', 'Order changed state — refresh and check again.', 409)

  let sent: { txHash: string; nonce: number } | null = null
  let journaled = false
  try {
    sent = await speedUpEvmDelivery(order, async (a) => {
      const earlier = await db.auditLog.findMany({ where: { targetType: 'GasFeeOrder', targetId: id, action: 'GAS_DELIVERY_SPEEDUP' }, select: { metadata: true } })
      const previous = new Set<string>([a.replacedTxHash])
      for (const r of earlier) {
        const p = (r.metadata as { previousTxHashes?: unknown } | null)?.previousTxHashes
        if (Array.isArray(p)) for (const h of p) if (typeof h === 'string') previous.add(h)
      }
      // Durable record FIRST (it is what keeps a replaced-but-landed tx from being mistaken for dead).
      await audit(actor, 'GAS_DELIVERY_SPEEDUP', id, {
        orderRef: order.orderRef, step: done + 1, nonce: a.nonce, newTxHash: a.newTxHash, previousTxHashes: [...previous],
        maxFeeGwei: Number(a.maxFeePerGas) / 1e9, maxPriorityFeeGwei: Number(a.maxPriorityFeePerGas) / 1e9,
      })
      await db.gasFeeOrder.update({ where: { id }, data: { unconfirmedDeliveryTxHash: a.newTxHash, deliveryAttemptAt: new Date() } })
      journaled = true
    })
  } catch (err) {
    if (!journaled) {
      // Nothing left the process — put the order back for the admin.
      await db.gasFeeOrder.updateMany({ where: { id, status: 'sending' }, data: { status: 'failed', failureReason: order.failureReason } })
      throw new AppError('CONFLICT', err instanceof Error ? err.message : 'Speed up failed', 409)
    }
    throw err
  }

  // Hand the new hash to the verifier: it finalizes the order when mined, or reports it stuck again.
  await queues.gasFee.add(
    'verify-delivery',
    { orderId: id, txHash: sent.txHash, startedAt: Date.now() },
    { jobId: `gas-verify-speedup-${id}-${Date.now()}`, attempts: 1 },
  )
  try { await queues.gasFee.remove(`gas-auto-refund-${id}`) } catch { /* non-fatal */ }
  return { txHash: sent.txHash, message: `Speed-up sent (+11% fee): ${sent.txHash}. You will be notified if it is still not mined in about 3 minutes.` }
}
