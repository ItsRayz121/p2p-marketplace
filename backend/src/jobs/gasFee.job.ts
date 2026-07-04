import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { deliverGas, describeDeliveryError } from '../lib/gas/gas.delivery'
import { logger } from '../lib/logger'
import { queues } from '../queues/definitions'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { fromDbChain } from '../lib/gas/gas.chains'
import { selectHotWallet } from '../lib/gas/gasWalletService'
import { createAdminNotif } from '../services/adminNotification.service'
import { recordGasAudit } from '../lib/gas/gas.matching'
import { accrueReferralForDelivery } from '../lib/gas/gas.referral'
import { awardGasPointsForDelivery } from '../services/airdrop.service'
import { REFUND_WINDOW_MS, AUTO_REFUND_SAFETY_MS, RETRY_INTERVAL_MS } from '../lib/gas/gas.refundWindow'
import type { GasFeeOrder } from '@prisma/client'

type HotWallet = Awaited<ReturnType<typeof selectHotWallet>> | null

// ── Shared success path ─────────────────────────────────────────────────────
// Marks the order delivered, writes the ledger entry, schedules the on-chain
// confirmation check, and fires notifications. Used by both the initial delivery
// (processGasFeeOrder) and the in-window retries (processGasDeliveryRetry), so a
// delivery that finally succeeds during the refund window is finalised identically.
async function finalizeDeliverySuccess(
  orderId: string,
  order: GasFeeOrder,
  deliveryTxHash: string,
  hotWallet: HotWallet,
): Promise<void> {
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: {
      status: 'delivered',
      deliveryTxHash,
      deliveryConfirmed: false,
      deliveredAt: new Date(),
      // Clear the refund window — delivery beat the clock.
      refundEligibleAt: null,
      fromHotWallet: hotWallet?.address ?? order.fromHotWallet,
    },
  })

  appendLedgerEntry({
    entryType:      'gas_delivery',
    // Aptos isn't in the GasChainId set — log it via chainOverride so the ledger
    // entry attributes correctly (token deliveries on Aptos, e.g. USDT/USDC).
    chain:          order.chain === 'APT' ? ('BSC' as GasChainId) : (fromDbChain(order.chain) as GasChainId),
    ...(order.chain === 'APT' ? { chainOverride: { dbChain: 'APT' as const, nativeSymbol: 'APT' } } : {}),
    nativeAmount:   -Number(order.gasAmountNative),
    usdAmount:      Number(order.gasAmountUSD),
    txHash:         deliveryTxHash,
    toAddress:      order.toAddress,
    relatedOrderId: orderId,
    notes:          `Delivery for order ${order.orderRef}`,
    ...(order.fromHotWallet ? { fromAddress: order.fromHotWallet } : {}),
  }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write delivery ledger entry'))

  // Enqueue on-chain confirmation check 60s after send (10 retries × 60s = 10 min window)
  await queues.gasFee.add(
    'check-delivery',
    { orderId, txHash: deliveryTxHash },
    {
      delay: 60_000,
      jobId: `gas-check-delivery-${orderId}`,
      attempts: 10,
      backoff: { type: 'fixed', delay: 60_000 },
    },
  )

  logger.info({ orderId, deliveryTxHash, chain: order.chain }, 'Gas fee delivered successfully')
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'delivered', txHash: deliveryTxHash, expectedChain: order.chain,
    detail: `Gas released: ${Number(order.gasAmountNative)} ${order.chain} → ${order.toAddress}`,
  })
  await notifyMerchantWebhook(orderId, 'delivered')
  // Gas referral: accrue the referrer's share of the realized margin (best-effort,
  // idempotent, no-op unless the flag is ON and the buyer is a bound referred user).
  await accrueReferralForDelivery(order).catch((e) => logger.warn({ err: e, orderId }, 'gas referral accrual failed'))
  // Airdrop: award a flat point per delivered paid gas order (idempotent, no-op when off).
  await awardGasPointsForDelivery(order).catch((e) => logger.warn({ err: e, orderId }, 'airdrop gas award failed'))
  // Gas orders count toward user trade stats — trigger unified badge recalculate
  if (order.userId) {
    queues.badgeRecalculate.add('recalc', { userId: order.userId }).catch(() => {})
  }
  void createAdminNotif({
    category: 'GAS',
    title: `Gas Sent — ${Number(order.gasAmountNative).toFixed(6)} ${order.chain}`,
    body: `Order ${order.orderRef} delivered to ${order.toAddress.slice(0, 10)}… Tx: ${deliveryTxHash.slice(0, 12)}…`,
    href: `/admin/gas/orders/${order.orderRef}`,
    metadata: { txHash: deliveryTxHash, orderId, chain: order.chain, toAddress: order.toAddress, amount: order.gasAmountNative },
  })
}

// Select the load-balanced hot wallet for the chain and stamp it on the order.
async function pickHotWallet(orderId: string, order: GasFeeOrder): Promise<{ hotWallet: HotWallet; hdIndex: number }> {
  const hotWallet = await selectHotWallet(order.chain).catch(() => null)
  if (hotWallet && hotWallet.address !== order.fromHotWallet) {
    await db.gasFeeOrder.update({ where: { id: orderId }, data: { fromHotWallet: hotWallet.address } })
  }
  return { hotWallet, hdIndex: hotWallet?.hdIndex ?? 0 }
}

// Schedule the next in-window delivery retry (single attempt). Unique jobId per
// scheduling so the linear retry chain isn't swallowed by jobId dedup.
async function scheduleDeliveryRetry(orderId: string): Promise<void> {
  await queues.gasFee.add(
    'retry-delivery',
    { orderId },
    { jobId: `gas-retry-${orderId}-${Date.now()}`, delay: RETRY_INTERVAL_MS, attempts: 1 },
  )
}

export async function processGasFeeOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // Respect the global pause switch — requeue with backoff if paused.
  const globalPause = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
  if (globalPause?.value === '1') {
    logger.warn({ orderId }, 'Gas delivery skipped — global pause is active')
    throw new Error('Gas delivery globally paused — will retry')
  }

  // DB-level CAS: atomically claim the order by transitioning payment_detected → sending.
  // If another worker process already claimed it, updateMany returns count=0 and we exit
  // immediately — no double-send is possible even under concurrent retries.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'payment_detected' },
    data: { status: 'sending' },
  })

  if (claimed.count === 0) {
    logger.info({ orderId }, 'Gas order already claimed or not in payment_detected — skipping')
    return
  }

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'Gas fee order not found after status claim — this should not happen')
    return
  }

  try {
    const { hotWallet, hdIndex } = await pickHotWallet(orderId, order)
    const deliveryTxHash = await deliverGas(order, hdIndex)
    await finalizeDeliverySuccess(orderId, order, deliveryTxHash, hotWallet)
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 3
    const rawErrMsg = err instanceof Error ? err.message : String(err)
    // Normalize the raw provider/RPC error (e.g. "Request failed with status code
    // 500", or SUI "No valid gas coins found") into an actionable reason +
    // recommended action for the admin. We branch on the NORMALIZED code so
    // chain-specific phrasings (SUI/SOL empty-wallet errors that carry no .code)
    // are still recognised as insufficient balance.
    const normalized = describeDeliveryError(order.chain, err)
    const errMsg = normalized.message

    logger.error({ orderId, attempt: attemptNumber, code: normalized.code, err: rawErrMsg, chain: order.chain }, 'Gas fee delivery failed')
    await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
      source: 'worker', event: 'delivery_failed', expectedChain: order.chain,
      reason: normalized.code, detail: `attempt ${attemptNumber}/${maxAttempts}: ${normalized.reason}. Action: ${normalized.action}. (raw: ${rawErrMsg.slice(0, 200)})`,
    })

    // Insufficient hot wallet balance — don't burn retries on a tx that can't succeed.
    // Reset to payment_detected, alert admin, and let the refill job replenish the wallet
    // before the next delivery attempt is scheduled via the balance monitor.
    if (normalized.code === 'INSUFFICIENT_HOT_WALLET_BALANCE') {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected', failureReason: errMsg },
      })
      void createAdminNotif({
        category: 'GAS',
        title: `Gas Delivery Paused — Insufficient Hot Wallet Balance`,
        body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\n\nThe hot wallet does not have enough native balance to deliver this order. A refill request should be raised. Delivery will resume once the balance is restored.\n\nError: ${errMsg}`,
        href: `/admin/gas/orders/${order.orderRef}`,
        telegram: true,
      })
      return
    }

    if (attemptNumber >= maxAttempts) {
      await enterRefundWindow(orderId, order, errMsg, maxAttempts)
    } else {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { retryCount: attemptNumber },
      })
      // Re-open status to payment_detected so the next BullMQ retry can claim it via CAS
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected' },
      })
      throw err
    }
  }
}

// ── Refund window ────────────────────────────────────────────────────────────
// Initial delivery has exhausted its attempts. Rather than refund instantly, a
// PAID order enters `awaiting_refund`: we keep retrying delivery for a few minutes
// (a flaky RPC may recover), the UI shows a countdown, and the user may request an
// immediate refund once REFUND_WINDOW_MS elapses. A safety-net auto-refund fires at
// AUTO_REFUND_SAFETY_MS so funds are never left stuck. An UNPAID order just fails.
async function enterRefundWindow(orderId: string, order: GasFeeOrder, errMsg: string, maxAttempts: number): Promise<void> {
  if (!order.paymentTxHash) {
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: errMsg, retryCount: maxAttempts },
    })
    await notifyMerchantWebhook(orderId, 'failed')
    void createAdminNotif({
      category: 'GAS',
      title: `Gas Fee Delivery Failed After ${maxAttempts} Attempts`,
      body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\nNext status: failed (no payment on record)`,
      href: `/admin/gas/orders/${order.orderRef}`,
      telegram: true,
    })
    return
  }

  const refundEligibleAt = new Date(Date.now() + REFUND_WINDOW_MS)
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: { status: 'awaiting_refund', failureReason: errMsg, retryCount: maxAttempts, refundEligibleAt },
  })

  // Keep trying to deliver during the window…
  await scheduleDeliveryRetry(orderId)
  // …and arm the safety-net auto-refund if the user never asks for one.
  await queues.gasFee.add(
    'auto-refund',
    { orderId },
    { jobId: `gas-auto-refund-${orderId}`, delay: AUTO_REFUND_SAFETY_MS, attempts: 1 },
  )

  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'awaiting_refund', expectedChain: order.chain,
    detail: `Delivery failed after ${maxAttempts} attempts — still retrying; refund available at ${refundEligibleAt.toISOString()}`,
  })
  await notifyMerchantWebhook(orderId, 'awaiting_refund')
  void createAdminNotif({
    category: 'GAS',
    title: `Gas Fee Delivery Failed — Awaiting Refund Window`,
    body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\n\nThe system will keep retrying delivery for ${Math.round(REFUND_WINDOW_MS / 60000)} min. The user can request a refund after that; an automatic refund fires at ${Math.round(AUTO_REFUND_SAFETY_MS / 60000)} min if not delivered.`,
    href: `/admin/gas/orders/${order.orderRef}`,
    telegram: true,
  })
}

// In-window delivery retry. Single attempt; on failure it reverts to
// awaiting_refund (preserving refundEligibleAt) and reschedules itself until the
// order is delivered, refunded, or the safety-net deadline is reached.
export async function processGasDeliveryRetry(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) return
  // Stop the chain if the order left the holding state (delivered, or a refund
  // was claimed by the user / auto-refund job).
  if (order.status !== 'awaiting_refund') return

  // Past the safety-net deadline? Stop retrying; the auto-refund job takes over.
  // refundEligibleAt = failureTime + REFUND_WINDOW_MS, so failureTime is derivable.
  if (order.refundEligibleAt) {
    const failureTime = new Date(order.refundEligibleAt).getTime() - REFUND_WINDOW_MS
    if (Date.now() - failureTime >= AUTO_REFUND_SAFETY_MS) return
  }

  // Don't attempt during a global pause — just reschedule.
  const globalPause = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
  if (globalPause?.value === '1') {
    await scheduleDeliveryRetry(orderId)
    return
  }

  // CAS claim: awaiting_refund → sending. Races the user button and the auto-refund
  // job (both do awaiting_refund → refund_pending); only one transition can win, so
  // we never deliver an order that's already being refunded.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'awaiting_refund' },
    data: { status: 'sending' },
  })
  if (claimed.count === 0) return

  const fresh = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!fresh) return

  try {
    const { hotWallet, hdIndex } = await pickHotWallet(orderId, fresh)
    const deliveryTxHash = await deliverGas(fresh, hdIndex)
    await finalizeDeliverySuccess(orderId, fresh, deliveryTxHash, hotWallet)
  } catch (err) {
    const rawErrMsg = err instanceof Error ? err.message : String(err)
    const normalized = describeDeliveryError(fresh.chain, err)
    // Revert to the holding state — keep the original refundEligibleAt so the
    // user's countdown isn't reset by each retry.
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'awaiting_refund', failureReason: normalized.message },
    })
    await recordGasAudit({ orderId, ...(fresh.paymentTxHash ? { txHash: fresh.paymentTxHash } : {}) }, {
      source: 'worker', event: 'delivery_failed', expectedChain: fresh.chain,
      reason: normalized.code, detail: `retry during refund window: ${normalized.reason}. (raw: ${rawErrMsg.slice(0, 200)})`,
    })
    await scheduleDeliveryRetry(orderId)
  }
}

// Safety-net automatic refund. Fires AUTO_REFUND_SAFETY_MS after a delivery failure
// if the order is STILL awaiting_refund (i.e. neither delivered nor user-refunded).
// Transitions awaiting_refund → refund_pending and hands off to the refund job.
export async function processGasAutoRefund(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order || order.status !== 'awaiting_refund') return // delivered or already refunding

  const moved = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'awaiting_refund' },
    data: { status: 'refund_pending' },
  })
  if (moved.count === 0) return

  await queues.gasFee.add(
    'process-refund',
    { orderId },
    { jobId: `gas-refund-${orderId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
  )
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'refund_pending', expectedChain: order.chain,
    detail: 'Auto-refund safety net: delivery still not completed — refunding USDT',
  })
  await notifyMerchantWebhook(orderId, 'refund_pending')
  logger.info({ orderId }, 'Gas order auto-refund (safety net) triggered')
}
