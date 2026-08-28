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
//
// AT THE DEADLINE we auto-complete EVERY such trade, not just those whose
// deliverer carries a trusted badge. USDT is non-custodial: finalizeUsdtTrade
// moves no crypto (the seller already sent it straight to the buyer), it only
// marks status + stats + streak and releases the maker's collateral bond. The
// buyer's protection is the dispute button — disputing moves the trade off
// crypto_sent, so the sweep's status filter naturally excludes it. As a human
// safety net, runUsdtConfirmAdminWarning gives admin a one-time heads-up
// ~ADMIN_WARN_LEAD_HOURS before a NON-trusted seller's trade auto-completes, so
// obvious fraud can still be caught and disputed in time.

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { createAdminNotif } from '../services/adminNotification.service'
import { stepFromStatus } from '../services/settlementFlow'
import { finalizeUsdtTrade, CONFIRM_WINDOW_HOURS } from '../services/trade.service'

/** Badge tiers we don't bother pre-warning admin about — their word is trusted enough. Mirrors CTM's verified/elite gate. */
const TRUSTED_BADGES = new Set(['trusted', 'top', 'elite'])

/** How long before the deadline admin gets a one-time "will auto-complete soon" heads-up for a non-trusted seller. */
const ADMIN_WARN_LEAD_HOURS = 6

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
      `Trade ${lbl(trade)} is waiting on your confirmation. Please review it soon — if it's not confirmed or disputed in time, it will auto-complete.`,
      { tradeId: trade.id },
      trade.id,
    )
  }

  if (due.length > 0) logger.info({ count: due.length }, 'USDT confirm reminder: nudges sent')
}

/**
 * Pre-deadline admin heads-up: for a trade whose deadline is within
 * ADMIN_WARN_LEAD_HOURS AND whose deliverer is NOT a trusted badge tier, tell
 * admin once so they can review (and dispute, if it looks like a scam) before
 * the auto-complete fires. Trusted deliverers are skipped — same bar as the old
 * auto-complete gate, just repurposed as "who do we bother a human about".
 */
export async function runUsdtConfirmAdminWarning(): Promise<void> {
  const now = new Date()
  const warnCutoff = new Date(now.getTime() + ADMIN_WARN_LEAD_HOURS * 60 * 60 * 1000)

  const due = await db.trade.findMany({
    where: {
      status: 'crypto_sent',
      confirmAdminWarnedAt: null,
      confirmDeadlineAt: { gt: now, lte: warnCutoff },
    },
    include: {
      buyer: { select: { tradeStats: { select: { badge: true } } } },
      seller: { select: { tradeStats: { select: { badge: true } } } },
    },
  })

  for (const trade of due) {
    const step = stepFromStatus(trade.takerFirst, 'crypto_sent')
    if (!step) continue

    const delivererBadge = (step.actor === 'buyer' ? trade.seller : trade.buyer).tradeStats?.badge
    const delivererIsTrusted = !!delivererBadge && TRUSTED_BADGES.has(delivererBadge)

    // CAS: claim the warn slot regardless (so trusted trades don't get re-checked
    // every sweep), but only actually notify admin for non-trusted deliverers.
    const claimed = await db.trade.updateMany({
      where: { id: trade.id, status: 'crypto_sent', confirmAdminWarnedAt: null },
      data: { confirmAdminWarnedAt: now },
    })
    if (claimed.count === 0) continue
    if (delivererIsTrusted) continue

    void createAdminNotif({
      category: 'TRADE',
      title: `⏳ Trade ${lbl(trade)} will auto-complete in ~${ADMIN_WARN_LEAD_HOURS}h`,
      body: `The seller delivered but the buyer hasn't confirmed, and the seller isn't a trusted badge tier. It auto-completes at the deadline — review now and dispute if it looks wrong.`,
      href: `/admin/trades/${trade.id}`,
      telegram: true,
    })
    logger.info({ tradeId: trade.id, delivererBadge }, 'USDT confirm deadline: admin pre-warned (non-trusted seller)')
  }

  if (due.length > 0) logger.info({ count: due.length }, 'USDT confirm admin-warning: sweep complete')
}

/**
 * Deadline pass: a trade still sitting in crypto_sent past its confirmDeadlineAt.
 * Auto-complete it via finalizeUsdtTrade — no badge gate. The only trades that
 * DON'T complete here are ones finalizeUsdtTrade itself rejects:
 *   • INVALID_STATUS — the confirmer acted in the same instant; that path won,
 *     nothing to do, and the row won't match the next sweep anyway.
 *   • NO_DELIVERY_PROOF — crypto_sent with neither a tx hash nor a screenshot,
 *     an inconsistent state we must not paper over: stop the clock and hand it
 *     to admin.
 */
export async function runUsdtConfirmDeadline(): Promise<void> {
  const now = new Date()

  const due = await db.trade.findMany({
    where: { status: 'crypto_sent', confirmDeadlineAt: { lte: now } },
    select: { id: true, orderRef: true, buyerId: true, sellerId: true, takerFirst: true },
  })

  for (const trade of due) {
    const step = stepFromStatus(trade.takerFirst, 'crypto_sent')
    if (!step) continue

    const confirmerId = step.actor === 'buyer' ? trade.buyerId : trade.sellerId
    const delivererId = step.actor === 'buyer' ? trade.sellerId : trade.buyerId

    try {
      // CAS guard lives inside finalizeUsdtTrade itself (SELECT FOR UPDATE +
      // status check) — a same-instant manual confirm wins and this throws
      // INVALID_STATUS, which we swallow below.
      await finalizeUsdtTrade(trade.id)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'NO_DELIVERY_PROOF') {
        // Inconsistent: crypto_sent with no proof at all. Stop the clock so this
        // doesn't re-fire every tick, and route to admin.
        await db.trade.update({ where: { id: trade.id }, data: { confirmDeadlineAt: null } })
        void createAdminNotif({
          category: 'TRADE',
          title: `⚠️ Trade ${lbl(trade)} can't auto-complete — no delivery proof`,
          body: `Trade is in crypto_sent past its confirmation deadline but carries no tx hash or screenshot. Please review manually.`,
          href: `/admin/trades/${trade.id}`,
          telegram: true,
        })
        logger.warn({ tradeId: trade.id }, 'USDT confirm deadline: no delivery proof — admin review needed')
        continue
      }
      // INVALID_STATUS or anything transient — leave the deadline in place; the
      // next sweep retries, or the row has already left crypto_sent.
      logger.warn({ err, tradeId: trade.id }, 'USDT auto-complete: trade not finalized this pass')
      continue
    }

    notify(confirmerId, 'trade', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed because you missed the confirmation deadline.`, { tradeId: trade.id }, trade.id)
    notify(delivererId, 'trade', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed after the counterparty's confirmation deadline passed.`, { tradeId: trade.id }, trade.id)
    logger.info({ tradeId: trade.id }, 'USDT auto-completed: confirmation deadline missed')
  }

  if (due.length > 0) logger.info({ count: due.length }, 'USDT confirm deadline: sweep complete')
}
