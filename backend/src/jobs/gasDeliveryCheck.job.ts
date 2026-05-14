import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { checkTxConfirmed } from '../lib/gas/gas.confirmation'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'

// Runs 60s after delivery. Retries every 60s for up to 10 attempts (10 min total).
// After all attempts are exhausted, BullMQ marks the job as permanently failed and
// the workers.ts `failed` event handler sends the admin alert.
export async function checkGasDelivery(job: Job<{ orderId: string; txHash: string }>) {
  const { orderId, txHash } = job.data

  const order = await db.gasFeeOrder.findUnique({
    where: { id: orderId },
    select: { chain: true },
  })
  if (!order) {
    logger.warn({ orderId }, 'checkGasDelivery: order not found — skipping')
    return
  }

  const confirmed = await checkTxConfirmed(order.chain as GasChainId, txHash)

  if (confirmed) {
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { deliveryConfirmed: true },
    })
    logger.info({ orderId, txHash, chain: order.chain }, 'Gas delivery confirmed on-chain')
    return
  }

  logger.debug(
    { orderId, txHash, chain: order.chain, attempt: job.attemptsMade + 1 },
    'Gas delivery not yet confirmed — will retry',
  )
  throw new Error('NOT_CONFIRMED_YET')
}
