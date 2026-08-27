// USDT final-confirmation deadline — the equivalent of ctm.jobs.ts's
// runCtmProofDeadline terminal branch, for the USDT marketplace.
//
// WHY THIS EXISTS: once a trade reaches the crypto_sent rung, the pending
// confirmer (buyer in the classic flow, seller/taker in taker-first) had NO
// deadline at all — if they simply forgot to tap "Confirm", the trade sat there
// forever, permanently occupying a concurrent-trade slot for BOTH parties
// (tradeConcurrency.service.ts caps each user at N active trades). That silent
// lock-up is the likely cause behind users hitting "too many active trades"
// with no visible reason: their own or their counterparty's abandoned trade was
// still "active" from the cap's point of view.
//
// confirmDeadlineAt is stamped (trade.service.ts) the moment a trade enters
// crypto_sent, in EITHER flow — that rung's pending step is always the terminal
// confirm action (confirm_crypto for classic, confirm_fiat for taker-first), so
// there is only ever one branch to handle here, unlike CTM's job which also
// covers several non-terminal mid-flow deadlines.

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { createAdminNotif } from '../services/adminNotification.service'
import { stepFromStatus } from '../services/settlementFlow'
import { finalizeUsdtTrade, CONFIRM_WINDOW_HOURS } from '../services/trade.service'

/** Badge tiers trusted enough to auto-complete on the deliverer's word alone — mirrors CTM's verified/elite gate. */
const TRUSTED_BADGES = new Set(['trusted', 'top', 'elite'])

const lbl = (t: { orderRef: string }) => `#${t.orderRef}`

/**
 * Halfway nudge: notify the pending confirmer once their trade is within half
 * the confirmation window of auto-resolving, so most cases get resolved by the
 * user noticing rather than by the deadline actually firing.
 */
export async function runUsdtConfirmReminder(): Promise<void> {
  const now = new Date()
  const reminderCutoff = new Date(now.getTime() + (CONFIRM_WINDOW_HOURS / 2) * 60 * 60 * 1000)

  const due = await db.trade.findMany({
    where: { status: 'crypto_sent', confirmDeadlineAt: { lte: reminderCutoff }, confirmReminderSentAt: null },
    select: { id: true, orderRef: true, buyerId: true, sellerId: true, takerFirst: true },
  })

  for (const trade of due) {
    const step = stepFromStatus(trade.takerFirst, 'crypto_sent')
    if (!step) continue // shouldn't happen — crypto_sent is always someone's pending rung
    const pendingId = step.actor === 'buyer' ? trade.buyerId : trade.sellerId

    // CAS: only the first tick to see confirmReminderSentAt:null sends it.
    const claimed = await db.trade.updateMany({
      where: { id: trade.id, status: 'crypto_sent', confirmReminderSentAt: null },
      data: { confirmReminderSentAt: now },
    })
    if (claimed.count === 0) continue

    notify(
      pendingId,
      'trade',
      'Action needed on your trade',
      `Trade ${lbl(trade)} is waiting on your confirmation. Please review it soon — if it's not confirmed or disputed in time, it may auto-complete or go to admin review.`,
      { tradeId: trade.id },
      trade.id,
    )
  }

  if (due.length > 0) logger.info({ count: due.length }, 'USDT confirm reminder: nudges sent')
}

/**
 * Deadline pass: a trade still sitting in crypto_sent past its confirmDeadlineAt.
 * Auto-complete trusting the deliverer if they're a badge-trusted trader (mirrors
 * CTM); otherwise clear the deadline and hand it to admin so it doesn't re-fire
 * every tick.
 */
export async function runUsdtConfirmDeadline(): Promise<void> {
  const now = new Date()

  const due = await db.trade.findMany({
    where: { status: 'crypto_sent', confirmDeadlineAt: { lte: now } },
    include: {
      buyer: { select: { tradeStats: { select: { badge: true } } } },
      seller: { select: { tradeStats: { select: { badge: true } } } },
    },
  })

  for (const trade of due) {
    const step = stepFromStatus(trade.takerFirst, 'crypto_sent')
    if (!step) continue

    const confirmerId = step.actor === 'buyer' ? trade.buyerId : trade.sellerId
    const delivererId = step.actor === 'buyer' ? trade.sellerId : trade.buyerId
    const delivererBadge = (step.actor === 'buyer' ? trade.seller : trade.buyer).tradeStats?.badge

    if (!delivererBadge || !TRUSTED_BADGES.has(delivererBadge)) {
      // Not trusted enough to auto-complete on their word alone — stop the clock
      // (so this doesn't re-fire every tick) and route to admin review, same as
      // CTM's untrusted-merchant path.
      await db.trade.update({ where: { id: trade.id }, data: { confirmDeadlineAt: null } })
      void createAdminNotif({
        category: 'TRADE',
        title: `⏰ Trade ${lbl(trade)} missed its confirmation deadline`,
        body: `The counterparty delivered but the confirmer hasn't acted, and the deliverer isn't a trusted badge tier — please review manually.`,
        href: `/admin/trades/${trade.id}`,
        telegram: true,
      })
      logger.warn({ tradeId: trade.id, delivererBadge }, 'USDT confirm deadline missed — admin review needed')
      continue
    }

    let didComplete = false
    try {
      // CAS guard lives inside finalizeUsdtTrade itself (SELECT FOR UPDATE +
      // status check) — if the confirmer acted in the same instant, that call
      // wins and finalizeUsdtTrade throws INVALID_STATUS here, which we swallow.
      await finalizeUsdtTrade(trade.id)
      didComplete = true
    } catch (err) {
      logger.warn({ err, tradeId: trade.id }, 'USDT auto-complete: trade no longer eligible (likely just confirmed manually)')
    }
    if (!didComplete) continue

    notify(confirmerId, 'trade', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed because you missed the confirmation deadline.`, { tradeId: trade.id }, trade.id)
    notify(delivererId, 'trade', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed after the counterparty's confirmation deadline passed.`, { tradeId: trade.id }, trade.id)
    logger.info({ tradeId: trade.id, delivererBadge }, 'USDT auto-completed: confirmation deadline missed')
  }

  if (due.length > 0) logger.info({ count: due.length }, 'USDT confirm deadline: sweep complete')
}
