// Runs every 30 minutes via BullMQ repeatable job
// Auto-cancels stale trades and escalates disputes

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { createAdminNotif } from '../services/adminNotification.service'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { releaseMakerBond } from '../services/makerBond.service'

export async function runTradeEscalation(): Promise<void> {
  const now = new Date()
  const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)

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
        // Anti-griefing penalty (non-custodial only): the buyer abandoned this
        // trade by never paying. Increment their abandon count and apply an
        // escalating cooldown (30 min × offenses) before they can start another.
        if (nonCustodial) {
          const [u] = await tx.$queryRaw<{ tradeAbandonCount: number }[]>`
            SELECT "tradeAbandonCount" FROM "User" WHERE id = ${trade.buyerId} FOR UPDATE
          `
          const offenses = (u?.tradeAbandonCount ?? 0) + 1
          const cooldownUntil = new Date(now.getTime() + Math.min(offenses, 6) * 30 * 60 * 1000)
          await tx.$executeRaw`
            UPDATE "User"
            SET "tradeAbandonCount" = ${offenses}, "tradeCooldownUntil" = ${cooldownUntil}
            WHERE id = ${trade.buyerId}
          `
        }
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
      // Buyer never paid → not a maker fault → return the maker's bond.
      await releaseMakerBond({ tradeType: 'usdt', tradeId: trade.id }).catch((err) =>
        logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond on auto-cancel'),
      )
      logger.info({ tradeId: trade.id }, 'Auto-cancelled stale trade')
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, 'Failed to auto-cancel trade')
    }
  }

  // 1b. Non-custodial release window: auto-escalate payment_confirmed trades
  // whose releaseDeadlineAt has passed (seller confirmed payment but never
  // released). Opens a dispute on the buyer's behalf so funds aren't left in
  // limbo. releaseDeadlineAt is only ever set while the flag is ON, but we guard
  // the flag too so this whole step is a no-op when non-custodial mode is off.
  let releaseEscalated = 0
  if (nonCustodial) {
    const staleRelease = await db.trade.findMany({
      where: { status: 'payment_confirmed', releaseDeadlineAt: { lt: now } },
      take: 200,
      orderBy: { releaseDeadlineAt: 'asc' },
      select: { id: true, buyerId: true, sellerId: true, orderRef: true },
    })
    for (const trade of staleRelease) {
      try {
        await db.$transaction(async (tx) => {
          const [current] = await tx.$queryRaw<{ status: string }[]>`
            SELECT status FROM "Trade" WHERE id = ${trade.id} FOR UPDATE
          `
          if (!current || current.status !== 'payment_confirmed') return
          // Skip if a dispute somehow already exists (unique tradeId).
          const existing = await tx.dispute.findUnique({ where: { tradeId: trade.id }, select: { id: true } })
          if (existing) return
          await tx.dispute.create({
            data: {
              tradeId: trade.id,
              openedById: trade.buyerId,
              reason: 'release_timeout',
              description: 'Auto-escalated: the seller confirmed payment but did not release within the release window.',
            },
          })
          await tx.trade.update({ where: { id: trade.id }, data: { status: 'disputed' } })
        })
        notify(trade.buyerId, 'dispute', 'Trade Escalated', 'The seller did not release in time, so your trade was escalated to a dispute for admin review.', { tradeId: trade.id }, trade.id)
        notify(trade.sellerId, 'dispute', 'Trade Escalated', 'You confirmed payment but did not release in time, so the trade was escalated to a dispute.', { tradeId: trade.id }, trade.id)
        createAdminNotif({ category: 'DISPUTE', title: 'Auto-escalated (release timeout)', body: `Trade #${trade.orderRef} — seller did not release in time.`, href: '/admin/disputes' })
        releaseEscalated++
      } catch (err) {
        logger.error({ err, tradeId: trade.id }, 'Failed to auto-escalate release-timeout trade')
      }
    }
  }

  // 2. Alert admin for payment_uploaded trades older than 2 hours (no action)
  const alertBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000)
  const awaitingReview = await db.trade.count({
    where: { status: 'payment_uploaded', updatedAt: { lt: alertBefore } },
  })
  if (awaitingReview > 0) {
    void createAdminNotif({
      category: 'TRADE',
      title: `⚠️ ${awaitingReview} trades awaiting payment review for >2 hours`,
      body: `${awaitingReview} trades have had payment proof uploaded for more than 2 hours without admin action. Please review.`,
      href: '/admin/trades',
      telegram: true,
    })
  }

  // 3. Escalate disputes older than 48 hours
  const disputeBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000)
  const oldDisputes = await db.dispute.count({
    where: { status: { in: ['open', 'under_review'] }, createdAt: { lt: disputeBefore } },
  })
  if (oldDisputes > 0) {
    void createAdminNotif({
      category: 'DISPUTE',
      title: `🚨 ${oldDisputes} disputes unresolved for >48 hours`,
      body: `${oldDisputes} disputes have been open for more than 48 hours. Immediate review required.`,
      href: '/admin/disputes',
      telegram: true,
    })
    // Update status to escalated
    await db.dispute.updateMany({
      where: { status: { in: ['open', 'under_review'] }, createdAt: { lt: disputeBefore } },
      data: { status: 'escalated' },
    })
  }

  logger.info(
    { cancelled: stalePending.length, releaseEscalated, awaitingReview, oldDisputes },
    'Trade escalation check complete',
  )
}
