import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { getNumberConfig } from './platformFlags.service'
import { createAdminNotif } from './adminNotification.service'

// ─── Risk warning signs for admins ───────────────────────────────────────────
//
// Early signals that a maker or user may be abusing the marketplace. These only
// INFORM admins (bell + push + Telegram via the "risk" group); they never block a
// user — trading holds, the scammer list and dispute auto-hold already do that.
//
// Every alert title starts with "Risk:" so classifyNotification files it under the
// "Risk warning signs" group, which each admin can mute or route separately.
//
// All entry points are fire-and-forget: callers `void` them after their own work
// has committed, and a failure here is logged, never surfaced to the user.

const DAY_MS = 24 * 60 * 60 * 1000

/** Claim a once-per-window slot so a repeating signal cannot spam admins. */
async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK'
  } catch {
    // Redis down: still alert. A rare duplicate beats a missed warning.
    return true
  }
}

async function label(userId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { username: true, email: true } })
  return u?.username ? `@${u.username}` : u?.email ?? userId
}

// ── 1. A maker's first dispute ───────────────────────────────────────────────

/**
 * Call after a dispute is opened (by a user or by auto-escalation). Alerts when it
 * is the FIRST dispute ever on a trade from this maker's ads/listings/requests.
 */
export async function alertOnDisputeOpened(market: 'usdt' | 'ctm', tradeId: string): Promise<void> {
  try {
    let makerId: string | null = null
    let ref = tradeId
    let count = 0
    if (market === 'usdt') {
      const t = await db.trade.findUnique({ where: { id: tradeId }, select: { orderRef: true, ad: { select: { userId: true } } } })
      makerId = t?.ad.userId ?? null
      ref = t?.orderRef ? `#${t.orderRef}` : tradeId
      if (makerId) count = await db.dispute.count({ where: { trade: { ad: { userId: makerId } } } })
    } else {
      const t = await db.ctmTrade.findUnique({
        where: { id: tradeId },
        select: { displayRef: true, listing: { select: { merchantProfile: { select: { userId: true } } } }, request: { select: { userId: true } } },
      })
      makerId = t?.listing?.merchantProfile.userId ?? t?.request?.userId ?? null
      ref = t?.displayRef ? `#${t.displayRef}` : tradeId
      if (makerId) {
        count = await db.ctmDispute.count({
          where: { trade: { OR: [{ listing: { merchantProfile: { userId: makerId } } }, { request: { userId: makerId } }] } },
        })
      }
    }
    if (!makerId || count !== 1) return
    if (!(await claimOnce(`risk:first-dispute:${makerId}`, 30 * 86_400))) return

    await createAdminNotif({
      category: 'DISPUTE',
      title: 'Risk: maker\'s first dispute',
      body: `${await label(makerId)} has their first dispute (${market.toUpperCase()} trade ${ref}). Worth a closer look at this maker.`,
      href: `/admin/users/${makerId}`,
      metadata: { userId: makerId, tradeId, market, signal: 'first_dispute' },
      telegram: true,
    })
  } catch (err) {
    logger.warn({ err, market, tradeId }, 'risk alert (first dispute) failed')
  }
}

// ── 2. Several cancellations in a day ────────────────────────────────────────

/**
 * Call after a user (not an admin) cancels a trade. Alerts once per 24h when the
 * user's own cancellations across USDT + CTM reach `risk_alert_cancels_per_day`.
 */
export async function alertOnCancellation(actorId: string): Promise<void> {
  try {
    const threshold = await getNumberConfig('risk_alert_cancels_per_day', 3)
    if (threshold <= 0) return
    const since = new Date(Date.now() - DAY_MS)
    const [usdt, ctm] = await Promise.all([
      db.trade.count({ where: { cancelledBy: actorId, cancelledAt: { gte: since } } }),
      db.ctmTrade.count({ where: { cancelledBy: actorId, cancelledAt: { gte: since } } }),
    ])
    const total = usdt + ctm
    if (total < threshold) return
    if (!(await claimOnce(`risk:cancels:${actorId}`, 86_400))) return

    await createAdminNotif({
      category: 'TRADE',
      title: 'Risk: many cancellations today',
      body: `${await label(actorId)} cancelled ${total} trades in the last 24 hours (USDT ${usdt}, CTM ${ctm}).`,
      href: `/admin/users/${actorId}`,
      metadata: { userId: actorId, usdt, ctm, signal: 'cancellations' },
      telegram: true,
    })
  } catch (err) {
    logger.warn({ err, actorId }, 'risk alert (cancellations) failed')
  }
}

// ── 3. A new maker posting a large ad ────────────────────────────────────────

/**
 * Call after a USDT ad is created. Alerts when the ad is at least
 * `risk_alert_large_ad_usdt` and the maker has fewer than
 * `risk_alert_new_maker_trades` completed trades on their own ads.
 */
export async function alertOnLargeAdByNewMaker(userId: string, adId: string, sizeUsdt: number): Promise<void> {
  try {
    const [minSize, newMakerTrades] = await Promise.all([
      getNumberConfig('risk_alert_large_ad_usdt', 1000),
      getNumberConfig('risk_alert_new_maker_trades', 5),
    ])
    if (minSize <= 0 || !(sizeUsdt >= minSize)) return
    const completed = await db.trade.count({ where: { status: 'crypto_released', ad: { userId } } })
    if (completed >= newMakerTrades) return
    if (!(await claimOnce(`risk:large-ad:${adId}`, 7 * 86_400))) return

    await createAdminNotif({
      category: 'TRADE',
      title: 'Risk: new maker posted a large ad',
      body: `${await label(userId)} posted a ${sizeUsdt.toLocaleString('en-US')} USDT ad with only ${completed} completed trade${completed === 1 ? '' : 's'} as a maker.`,
      href: `/admin/users/${userId}`,
      metadata: { userId, adId, sizeUsdt, completed, signal: 'large_ad_new_maker' },
      telegram: true,
    })
  } catch (err) {
    logger.warn({ err, userId, adId }, 'risk alert (large ad) failed')
  }
}

// ── 4. Contact details shared with another account ───────────────────────────

/**
 * Call after a KYC submission that carries a WhatsApp number or community links.
 * Alerts when another account already uses the same number or link.
 */
export async function alertOnSharedContacts(
  userId: string,
  submissionId: string,
  shared: { whatsapp: Array<{ userId: string; username: string | null }>; community: Array<{ userId: string; username: string | null; url: string }> },
): Promise<void> {
  try {
    if (shared.whatsapp.length === 0 && shared.community.length === 0) return
    if (!(await claimOnce(`risk:shared-contacts:${submissionId}`, 7 * 86_400))) return
    const who = (r: { userId: string; username: string | null }) => (r.username ? `@${r.username}` : r.userId)
    const parts: string[] = []
    if (shared.whatsapp.length) parts.push(`WhatsApp number also on ${shared.whatsapp.map(who).join(', ')}`)
    if (shared.community.length) parts.push(`community link also on ${[...new Set(shared.community.map(who))].join(', ')}`)
    await createAdminNotif({
      category: 'KYC',
      title: 'Risk: contact details shared with another account',
      body: `${await label(userId)}'s KYC: ${parts.join('; ')}.`,
      href: '/admin/kyc',
      metadata: { userId, submissionId, signal: 'shared_contacts' },
      telegram: true,
    })
  } catch (err) {
    logger.warn({ err, userId }, 'risk alert (shared contacts) failed')
  }
}
