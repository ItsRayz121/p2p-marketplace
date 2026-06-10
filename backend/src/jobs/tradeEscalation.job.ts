// Runs every 30 minutes via BullMQ repeatable job
// Auto-cancels stale trades and escalates disputes

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'

export async function runTradeEscalation(): Promise<void> {
  const now = new Date()

  // 1. Auto-cancel payment_pending trades that have passed their expiresAt deadline
  // take: 200 prevents OOM if many trades expire simultaneously (e.g. after downtime)
  const stalePending = await db.trade.findMany({
    where: { status: 'payment_pending', expiresAt: { lt: now } },
    take: 200,
    orderBy: { expiresAt: 'asc' },
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
        // Clamped at 0 — the buyer's daily window may have reset since this
        // trade incremented the counter.
        await tx.$executeRaw`
          UPDATE "User"
          SET "dailyBuyUsed" = GREATEST("dailyBuyUsed" - ${trade.fiatAmount ?? 0}, 0)
          WHERE id = ${trade.buyerId}
        `
        // Restore inventory AND reactivate the ad if this trade had consumed
        // the last of it (status flipped to 'completed' at creation time) —
        // mirrors the manual cancelTrade path.
        const ad = await tx.ad.findUnique({ where: { id: trade.adId }, select: { status: true } })
        await tx.ad.update({
          where: { id: trade.adId },
          data: {
            availableAmount: { increment: trade.amount },
            ...(ad?.status === 'completed' ? { status: 'active' } : {}),
          },
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
