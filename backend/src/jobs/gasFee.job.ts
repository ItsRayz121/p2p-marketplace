import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { deliverGas } from '../lib/gas/gas.delivery'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import { queues } from '../queues/definitions'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'

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
    const deliveryTxHash = await deliverGas(order)

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        status: 'delivered',
        deliveryTxHash,
        deliveryConfirmed: false,
        deliveredAt: new Date(),
      },
    })

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
    await notifyMerchantWebhook(orderId, 'delivered')
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 3
    const errMsg = err instanceof Error ? err.message : String(err)

    logger.error({ orderId, attempt: attemptNumber, err: errMsg, chain: order.chain }, 'Gas fee delivery failed')

    if (attemptNumber >= maxAttempts) {
      // Final failure: if payment was received, move to refund_pending so the automated
      // refund job can return the USDT. Otherwise mark as failed directly.
      const nextStatus = order.paymentTxHash ? 'refund_pending' : 'failed'
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: nextStatus, failureReason: errMsg, retryCount: attemptNumber },
      })

      if (nextStatus === 'refund_pending') {
        await queues.gasFee.add(
          'process-refund',
          { orderId },
          { jobId: `gas-refund-${orderId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
        )
        logger.info({ orderId }, 'Gas delivery failed — queued for automated refund')
      }

      await notifyMerchantWebhook(orderId, nextStatus)
      await sendAdminAlertEmail(
        `Gas Fee Delivery Failed After ${maxAttempts} Attempts`,
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\nNext status: ${nextStatus}`,
      )
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
