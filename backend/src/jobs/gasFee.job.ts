import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'

export async function processGasFeeOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // Idempotency check
  const idemKey = `gas_sent:${orderId}`
  const alreadySent = await redis.get(idemKey)
  if (alreadySent) {
    logger.info({ orderId }, 'Gas fee already sent, skipping')
    return
  }

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'Gas fee order not found')
    return
  }

  if (order.status !== 'payment_detected' && order.status !== 'payment_pending') {
    logger.info({ orderId, status: order.status }, 'Gas fee order not in payment state, skipping')
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

  // Update to sending status
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: { status: 'sending' },
  })

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TronWeb = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULL_NODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
      privateKey,
    })

    // Convert TRX to SUN (1 TRX = 1,000,000 SUN)
    const sunAmount = Math.floor(Number(order.gasAmountNative) * 1_000_000)

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

    // Set idempotency key so we don't re-send
    await redis.setex(idemKey, 86400, '1')

    logger.info({ orderId, deliveryTxHash }, 'Gas fee delivered successfully')
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = 3
    const errMsg = err instanceof Error ? err.message : String(err)

    logger.error({ orderId, attempt: attemptNumber, err: errMsg }, 'Gas fee delivery failed')

    if (attemptNumber >= maxAttempts) {
      // Final failure
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
      // BullMQ will retry based on job's backoff config
      throw err
    }
  }
}
