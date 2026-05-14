import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { queues } from '../queues/definitions'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { logger } from '../lib/logger'

// Handles two modes:
//   expire-order  — delayed per-order job (job.data.orderId present): expire only that order
//   expire-sweep  — repeatable 60s sweeper (no orderId): expire all overdue payment_pending orders
export async function runGasExpiryJob(job: Job<{ orderId?: string }>) {
  const { orderId } = job.data ?? {}

  if (orderId) {
    const result = await db.gasFeeOrder.updateMany({
      where: { id: orderId, status: 'payment_pending' },
      data: { status: 'expired' },
    })
    if (result.count > 0) {
      logger.info({ orderId }, 'Gas order expired by per-order job')
      await notifyMerchantWebhook(orderId, 'expired')
    }
    return { expired: result.count }
  }

  // Sweeper: expire all overdue payment_pending orders
  const expiredResult = await db.gasFeeOrder.updateMany({
    where: { status: 'payment_pending', expiresAt: { lt: new Date() } },
    data: { status: 'expired' },
  })
  if (expiredResult.count > 0) {
    logger.info({ count: expiredResult.count }, 'Gas expiry sweep: expired overdue orders')
  }

  // Edge case: payment_detected orders past their expiry window — payment arrived but
  // the order was never claimed for delivery (e.g. delivery job never ran).
  // Move to refund_pending so the automated refund job returns the USDT.
  const stuckOrders = await db.gasFeeOrder.findMany({
    where: { status: 'payment_detected', expiresAt: { lt: new Date() } },
    select: { id: true, orderRef: true },
  })

  if (stuckOrders.length > 0) {
    await db.gasFeeOrder.updateMany({
      where: { id: { in: stuckOrders.map((o) => o.id) } },
      data: { status: 'refund_pending' },
    })

    // Enqueue a refund job for each stuck order (jobId dedup prevents duplicates)
    for (const o of stuckOrders) {
      await queues.gasFee.add(
        'process-refund',
        { orderId: o.id },
        { jobId: `gas-refund-${o.id}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
      )
      await notifyMerchantWebhook(o.id, 'refund_pending')
    }

    logger.warn(
      { count: stuckOrders.length, refs: stuckOrders.map((o) => o.orderRef) },
      'Gas expiry sweep: found stuck payment_detected orders — moved to refund_pending',
    )
  }

  return { expired: expiredResult.count, refundQueued: stuckOrders.length }
}
