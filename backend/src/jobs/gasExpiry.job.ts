import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
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
    }
    return { expired: result.count }
  }

  // Sweeper: expire all overdue orders in one batch
  const result = await db.gasFeeOrder.updateMany({
    where: { status: 'payment_pending', expiresAt: { lt: new Date() } },
    data: { status: 'expired' },
  })
  if (result.count > 0) {
    logger.info({ count: result.count }, 'Gas expiry sweep: expired overdue orders')
  }
  return { expired: result.count }
}
