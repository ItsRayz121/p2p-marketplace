import { db } from './prisma'
import { AppError } from './errors'

/**
 * Trading hold: the scam / dispute control that sits between "Under review"
 * (informational) and Suspend/Ban (full lockout).
 *
 * A user on hold can still log in, chat and answer their dispute, but cannot post
 * ads/listings or open/accept trades. Existing trades keep running so open
 * obligations can still be settled (see disputeResume.ts for the dispute rules).
 */

export type HoldAction = 'post' | 'trade'

const MESSAGES: Record<HoldAction, string> = {
  post: 'Your account is on a trading hold, so you cannot post ads or listings right now.',
  trade: 'Your account is on a trading hold, so you cannot start or accept trades right now.',
}

/** Throws TRADING_HOLD when the user is on hold. No-op for unknown users. */
export async function assertNotOnTradingHold(userId: string, action: HoldAction): Promise<void> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { tradingHold: true, tradingHoldReason: true } })
  if (!u?.tradingHold) return
  const reason = u.tradingHoldReason ? ` Reason: ${u.tradingHoldReason}` : ''
  throw new AppError(
    'TRADING_HOLD',
    `${MESSAGES[action]}${reason} Resolve the open dispute or contact support to have it lifted.`,
    403,
  )
}

/** Same check, but against the counterparty — the message names no one. */
export async function assertCounterpartyNotOnHold(counterpartyId: string): Promise<void> {
  const u = await db.user.findUnique({ where: { id: counterpartyId }, select: { tradingHold: true } })
  if (u?.tradingHold) {
    throw new AppError('COUNTERPARTY_ON_HOLD', 'This trader is currently unavailable for new trades.', 409)
  }
}

/**
 * Open disputes AGAINST each user (they are the respondent — the party that did
 * not open it). Powers the public "Disputed" badge and the scammer list.
 * Both the USDT and CTM dispute tables count.
 */
export async function countOpenDisputesAgainst(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return out
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1)
  const wanted = new Set(ids)

  const [usdt, ctm] = await Promise.all([
    db.dispute.findMany({
      where: { status: { not: 'resolved' }, trade: { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }] } },
      select: { openedById: true, trade: { select: { buyerId: true, sellerId: true } } },
    }),
    db.ctmDispute.findMany({
      where: { status: { not: 'resolved' }, trade: { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }] } },
      select: { openedById: true, trade: { select: { buyerId: true, sellerId: true } } },
    }),
  ])
  for (const d of [...usdt, ...ctm]) {
    const respondent = d.openedById === d.trade.buyerId ? d.trade.sellerId : d.trade.buyerId
    if (wanted.has(respondent)) bump(respondent)
  }
  return out
}

/** Pause every live ad / CTM listing the user owns. Returns how many were paused. */
export async function pauseUserListings(userId: string): Promise<{ ads: number; listings: number }> {
  const [ads, listings] = await Promise.all([
    db.ad.updateMany({ where: { userId, status: 'active' }, data: { status: 'paused' } }),
    db.ctmListing.updateMany({
      where: { merchantProfile: { userId }, status: 'active' },
      data: { status: 'paused' },
    }),
  ])
  return { ads: ads.count, listings: listings.count }
}

/**
 * Which of these users should show the public "Disputed" badge: anyone on a
 * trading hold, or with at least one open dispute against them. The badge only
 * says a dispute is open — never "scam" — so a false claim can't brand someone.
 */
export async function getDisputedUserIds(userIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  const out = new Set<string>()
  if (ids.length === 0) return out
  const [held, counts] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids }, tradingHold: true }, select: { id: true } }),
    countOpenDisputesAgainst(ids),
  ])
  for (const h of held) out.add(h.id)
  for (const [id, n] of counts) if (n > 0) out.add(id)
  return out
}
