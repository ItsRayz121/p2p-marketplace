// Runs every 30 minutes via BullMQ repeatable job
// Auto-cancels stale trades and escalates disputes

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { createAdminNotif } from '../services/adminNotification.service'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { releaseMakerBond } from '../services/makerBond.service'
import { closeEpisode } from '../services/chatThread.service'
import { stepFromStatus } from '../services/settlementFlow'

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
        // Anti-griefing penalty (non-custodial only): the FIRST MOVER abandoned this
        // trade by never acting at payment_pending. In the classic flow the first
        // mover is the buyer (owes fiat); in a taker-first trade it's the seller
        // (taker, owes crypto). Penalize whoever actually stalled. Increment their
        // abandon count and apply an escalating cooldown (30 min × offenses).
        if (nonCustodial) {
          const abandonUserId = trade.takerFirst ? trade.sellerId : trade.buyerId
          const [u] = await tx.$queryRaw<{ tradeAbandonCount: number }[]>`
            SELECT "tradeAbandonCount" FROM "User" WHERE id = ${abandonUserId} FOR UPDATE
          `
          const offenses = (u?.tradeAbandonCount ?? 0) + 1
          const cooldownUntil = new Date(now.getTime() + Math.min(offenses, 6) * 30 * 60 * 1000)
          await tx.$executeRaw`
            UPDATE "User"
            SET "tradeAbandonCount" = ${offenses}, "tradeCooldownUntil" = ${cooldownUntil}
            WHERE id = ${abandonUserId}
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
      void closeEpisode({ market: 'usdt', tradeId: trade.id, outcome: 'expired' })
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
          // Dispute-resume: remember the rung so the seller can still release and the
          // buyer still confirm while this auto-dispute is open — a missed release
          // window is often a timezone gap, not a scam. Completing closes the dispute.
          await tx.trade.update({ where: { id: trade.id }, data: { status: 'disputed', disputeResumeStatus: 'payment_confirmed' } })
        })
        notify(trade.buyerId, 'dispute', 'Trade Escalated', 'The seller did not release in time, so your trade was escalated to a dispute for admin review.', { tradeId: trade.id }, trade.id)
        notify(trade.sellerId, 'dispute', 'Trade Escalated', 'You confirmed payment but did not release in time, so the trade was escalated to a dispute.', { tradeId: trade.id }, trade.id)
        void createAdminNotif({ category: 'DISPUTE', title: 'Auto-escalated (release timeout)', body: `Trade #${trade.orderRef} — seller did not release in time.`, href: '/admin/disputes' })
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

  // 2b. Auto-escalate payment_uploaded trades stuck for >24h — the first leg was
  // delivered (classic: buyer paid fiat; taker-first: taker sent crypto) and the
  // counterparty went dark on the confirm step. Unlike crypto_sent (handled by
  // usdtTradeDeadline.job with an auto-COMPLETE), the second leg is NOT delivered
  // here, so completing would be wrong — open a dispute on the waiting party's
  // behalf instead. Mirrors step 1b's non-custodial release-timeout escalation,
  // but is flow-agnostic and runs regardless of the non-custodial flag.
  const uploadedStaleBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const staleUploaded = await db.trade.findMany({
    where: { status: 'payment_uploaded', updatedAt: { lt: uploadedStaleBefore } },
    take: 200,
    orderBy: { updatedAt: 'asc' },
    select: { id: true, buyerId: true, sellerId: true, orderRef: true, takerFirst: true },
  })
  let uploadedEscalated = 0
  for (const trade of staleUploaded) {
    // Pending step out of payment_uploaded: classic = seller's confirm_fiat,
    // taker-first = buyer's confirm_crypto. Whoever that actor is went dark.
    const step = stepFromStatus(trade.takerFirst, 'payment_uploaded')
    if (!step) continue
    const missedActorId = step.actor === 'buyer' ? trade.buyerId : trade.sellerId
    const openerId = step.actor === 'buyer' ? trade.sellerId : trade.buyerId
    const reason = step.actor === 'buyer' ? 'buyer_unresponsive' : 'seller_unresponsive'
    try {
      await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM "Trade" WHERE id = ${trade.id} FOR UPDATE
        `
        if (!current || current.status !== 'payment_uploaded') return
        const existing = await tx.dispute.findUnique({ where: { tradeId: trade.id }, select: { id: true } })
        if (existing) return
        await tx.dispute.create({
          data: {
            tradeId: trade.id,
            openedById: openerId,
            reason,
            description: `Auto-escalated: the ${step.actor} did not respond within 24h of payment proof being uploaded.`,
          },
        })
        // Dispute-resume: park status at `disputed` for admin tooling but remember
        // the rung so both parties can still settle while the dispute is open — a
        // missed confirm is often a timezone gap, not a scam. Completing closes it.
        await tx.trade.update({ where: { id: trade.id }, data: { status: 'disputed', disputeResumeStatus: 'payment_uploaded' } })
      })
      notify(openerId, 'dispute', 'Trade Escalated', `The ${step.actor} did not respond in time, so your trade was escalated to a dispute for admin review.`, { tradeId: trade.id }, trade.id)
      notify(missedActorId, 'dispute', 'Trade Escalated', 'You did not respond in time after payment proof was uploaded, so the trade was escalated to a dispute.', { tradeId: trade.id }, trade.id)
      void createAdminNotif({ category: 'DISPUTE', title: 'Auto-escalated (no response after upload)', body: `Trade #${trade.orderRef} — the ${step.actor} went dark >24h at payment_uploaded.`, href: '/admin/disputes' })
      uploadedEscalated++
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, 'Failed to auto-escalate stale payment_uploaded trade')
    }
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
    // Update status to escalated — an admin-visibility flag, NOT an admin takeover.
    // It fires precisely BECAUSE nobody has looked at the case for 48h, so it must
    // not freeze the step ladder: that would leave the trade both neglected AND
    // unfinishable. Only real admin engagement (posting in the dispute thread)
    // freezes it — see disputeResume.ts. Mirrors runCtmDisputeEscalation, which
    // likewise only flags.
    await db.dispute.updateMany({
      where: { status: { in: ['open', 'under_review'] }, createdAt: { lt: disputeBefore } },
      data: { status: 'escalated' },
    })
  }

  logger.info(
    { cancelled: stalePending.length, releaseEscalated, uploadedEscalated, awaitingReview, oldDisputes },
    'Trade escalation check complete',
  )
}
