import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { env } from '../lib/env'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'

export async function processGasFeeOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

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

  // Fetch the full order now that we own it
  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'Gas fee order not found after status claim — this should not happen')
    return
  }

  const privateKey = env.GAS_WALLET_PRIVATE_KEY_TRON
  if (!privateKey) {
    logger.error({ orderId }, 'GAS_WALLET_PRIVATE_KEY_TRON not configured')
    await sendAdminAlertEmail(
      'Gas Fee Job Failed: Missing Private Key',
      `Order ${orderId} cannot be processed: GAS_WALLET_PRIVATE_KEY_TRON is not configured.`,
    )
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: 'Hot wallet private key not configured' },
    })
    return
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TronWeb = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULL_NODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
      privateKey,
    })

    // Convert TRX to SUN (1 TRX = 1,000,000 SUN). Use Math.round to avoid
    // floating-point truncation errors on fractional TRX amounts.
    const sunAmount = Math.round(Number(order.gasAmountNative) * 1_000_000)

    const result = await tronWeb.trx.sendTransaction(order.toAddress, sunAmount)

    if (!result.result) {
      throw new Error(`TronWeb sendTransaction failed: ${JSON.stringify(result)}`)
    }

    const deliveryTxHash = result.txid as string

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        status: 'delivered',
        deliveryTxHash,
        deliveryConfirmed: true,
        deliveredAt: new Date(),
      },
    })

    logger.info({ orderId, deliveryTxHash }, 'Gas fee delivered successfully')
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 3
    const errMsg = err instanceof Error ? err.message : String(err)

    logger.error({ orderId, attempt: attemptNumber, err: errMsg }, 'Gas fee delivery failed')

    if (attemptNumber >= maxAttempts) {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'failed', failureReason: errMsg, retryCount: attemptNumber },
      })
      await sendAdminAlertEmail(
        `Gas Fee Delivery Failed After ${maxAttempts} Attempts`,
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} TRX\nError: ${errMsg}`,
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
      throw err // Signal BullMQ to schedule exponential-backoff retry
    }
  }
}
