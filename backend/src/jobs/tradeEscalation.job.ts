// Runs every 30 minutes via BullMQ repeatable job
// Auto-cancels stale trades and escalates disputes

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'

export async function runTradeEscalation(): Promise<void> {
  const now = new Date()

  // 1. Auto-cancel payment_pending trades older than 4 hours
  const cancelBefore = new Date(now.getTime() - 4 * 60 * 60 * 1000)
  const stalePending = await db.trade.findMany({
    where: { status: 'payment_pending', createdAt: { lt: cancelBefore } },
    include: {
      buyer: { select: { email: true } },
      seller: { select: { email: true } },
      ad: true,
    },
  })

  for (const trade of stalePending) {
    try {
      await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM "Trade" WHERE id = ${trade.id} FOR UPDATE
        `
        if (!current || current.status !== 'payment_pending') return

        await tx.trade.update({
          where: { id: trade.id },
          data: {
            status: 'cancelled',
            cancelReason: 'Auto-cancelled: payment not received within 4 hours',
            cancelledAt: now,
          },
        })
        await tx.user.update({
          where: { id: trade.buyerId },
          data: { dailyBuyUsed: { decrement: Number(trade.fiatAmount ?? 0) } },
        })
        await tx.ad.update({
          where: { id: trade.adId },
          data: { availableAmount: { increment: trade.amount } },
        })
      })
      logger.info({ tradeId: trade.id }, 'Auto-cancelled stale trade')
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, 'Failed to auto-cancel trade')
    }
  }

  // 2. Alert admin for payment_uploaded trades older than 2 hours (no action)
  const alertBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000)
  const awaitingReview = await db.trade.count({
    where: { status: 'payment_uploaded', updatedAt: { lt: alertBefore } },
  })
  if (awaitingReview > 0) {
    await sendAdminAlertEmail(
      `⚠️ ${awaitingReview} trades awaiting payment review for >2 hours`,
      `${awaitingReview} trades have had payment proof uploaded for more than 2 hours without admin action. Please review: /admin/trades`,
    ).catch(() => {})
  }

  // 3. Escalate disputes older than 48 hours
  const disputeBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000)
  const oldDisputes = await db.dispute.count({
    where: { status: { in: ['open', 'under_review'] }, createdAt: { lt: disputeBefore } },
  })
  if (oldDisputes > 0) {
    await sendAdminAlertEmail(
      `🚨 ${oldDisputes} disputes unresolved for >48 hours`,
      `${oldDisputes} disputes have been open for more than 48 hours. Immediate review required: /admin/disputes`,
    ).catch(() => {})
    // Update status to escalated
    await db.dispute.updateMany({
      where: { status: { in: ['open', 'under_review'] }, createdAt: { lt: disputeBefore } },
      data: { status: 'escalated' },
    })
  }

  logger.info(
    { cancelled: stalePending.length, awaitingReview, oldDisputes },
    'Trade escalation check complete',
  )
}
