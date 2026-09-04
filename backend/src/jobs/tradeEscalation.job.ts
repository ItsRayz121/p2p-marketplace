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

  // 1b. Release window: auto-escalate payment_confirmed trades whose
  // releaseDeadlineAt has passed. Runs unconditionally (releaseDeadlineAt is now
  // always stamped, regardless of the non-custodial flag) — previously this was
  // flag-gated, which left payment_confirmed trades with no expiry path at all
  // while the flag was off: a party who went dark after this rung could occupy
  // both parties' concurrency-cap slot indefinitely. Mirrors CTM's
  // runCtmProofDeadline, which is likewise unconditional.
  //
  // Flow-aware: `payment_confirmed` means a different pending party depending on
  // `takerFirst` — classic: the SELLER owes crypto (they already hold it, short
  // window); taker-first: the BUYER/maker owes fiat (they just acknowledged the
  // taker's crypto, needs real bank-transfer time — see PAY_AFTER_CRYPTO_WINDOW_MIN
  // in trade.service.ts). Opening the dispute against the wrong party, or with
  // "the seller did not release" wording on what's actually a stalled fiat
  // payment, used to be silently wrong for every taker-first trade reaching this
  // rung — `stepFromStatus` resolves the real pending actor per trade.
  let releaseEscalated = 0
  {
    const staleRelease = await db.trade.findMany({
      where: { status: 'payment_confirmed', releaseDeadlineAt: { lt: now } },
      take: 200,
      orderBy: { releaseDeadlineAt: 'asc' },
      select: { id: true, buyerId: true, sellerId: true, orderRef: true, takerFirst: true },
    })
    for (const trade of staleRelease) {
      const step = stepFromStatus(trade.takerFirst, 'payment_confirmed')
      if (!step) continue // shouldn't happen — payment_confirmed always has a pending step
      const missedActorId = step.actor === 'seller' ? trade.sellerId : trade.buyerId
      const openerId = step.actor === 'seller' ? trade.buyerId : trade.sellerId
      const actionText = step.action === 'send_crypto' ? 'release the crypto' : 'send the PKR payment'
      try {
        // Report back whether this pass actually created the dispute — the party
        // may have acted (released/paid) or a dispute may already exist by the time
        // the loop reaches this trade, in which case the transaction is a deliberate
        // no-op and must NOT be followed by a "your trade was escalated" notice.
        const escalated = await db.$transaction(async (tx) => {
          const [current] = await tx.$queryRaw<{ status: string }[]>`
            SELECT status FROM "Trade" WHERE id = ${trade.id} FOR UPDATE
          `
          if (!current || current.status !== 'payment_confirmed') return false
          // Skip if a dispute somehow already exists (unique tradeId).
          const existing = await tx.dispute.findUnique({ where: { tradeId: trade.id }, select: { id: true } })
          if (existing) return false
          await tx.dispute.create({
            data: {
              tradeId: trade.id,
              openedById: openerId,
              reason: step.action === 'send_crypto' ? 'release_timeout' : 'fiat_payment_timeout',
              description: `Auto-escalated: the ${step.actor} did not ${actionText} within the release window.`,
            },
          })
          // Dispute-resume: remember the rung so the pending party can still act and
          // the counterparty still confirm while this auto-dispute is open — a missed
          // window is often a timezone gap, not a scam. Completing closes the dispute.
          await tx.trade.update({ where: { id: trade.id }, data: { status: 'disputed', disputeResumeStatus: 'payment_confirmed' } })
          return true
        })
        if (!escalated) continue
        notify(openerId, 'dispute', 'Trade Escalated', `The ${step.actor} did not ${actionText} in time, so your trade was escalated to a dispute for admin review.`, { tradeId: trade.id }, trade.id)
        notify(missedActorId, 'dispute', 'Trade Escalated', `You did not ${actionText} in time, so the trade was escalated to a dispute.`, { tradeId: trade.id }, trade.id)
        void createAdminNotif({ category: 'DISPUTE', title: 'Auto-escalated (release timeout)', body: `Trade #${trade.orderRef} — ${step.actor} did not ${actionText} in time.`, href: '/admin/disputes' })
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
      // Same false-positive guard as block 1b above: report back whether this pass
      // actually created the dispute, and skip the "escalated" notice on a no-op
      // (the party responded, or a dispute already exists, by the time the loop
      // reaches this trade).
      const escalated = await db.$transaction(async (tx) => {
        const [current] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM "Trade" WHERE id = ${trade.id} FOR UPDATE
        `
        if (!current || current.status !== 'payment_uploaded') return false
        const existing = await tx.dispute.findUnique({ where: { tradeId: trade.id }, select: { id: true } })
        if (existing) return false
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
        return true
      })
      if (!escalated) continue
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
