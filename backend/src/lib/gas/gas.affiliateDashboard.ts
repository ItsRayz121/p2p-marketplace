/**
 * Affiliate dashboard read model: everything an affiliate (or any referrer) needs to see in
 * real time on one page: tier + progress, link stats (clicks / sign-ups / orders / earned),
 * every referred user with their own order count and commission, and a live earnings feed.
 */
import { db } from '../prisma'
import { getReferralSummary, type ReferralSummary } from './gas.referral'
import { getAffiliateTierInfo, type AffiliateTierInfo } from './gas.affiliateTier'

function num(d: unknown): number { return Number(d ?? 0) }
function round2(n: number): number { return Math.round(n * 100) / 100 }

export interface DashboardLink {
  id: string
  code: string
  label: string | null
  isActive: boolean
  isPrimary: boolean
  clicks: number
  lastClickAt: string | null
  signups: number
  orders: number
  earnedUsdt: number
}

export interface DashboardReferral {
  referredId: string
  username: string
  joinedAt: string
  linkCode: string
  linkLabel: string | null
  orders: number
  marginUsdt: number
  earnedUsdt: number
  lastOrderAt: string | null
}

export interface DashboardFeedItem {
  id: string
  at: string
  level: number
  amountUsdt: number
  pct: number
  username: string | null
  status: string
}

export interface AffiliateDashboard {
  isAffiliate: boolean
  affiliateStatus: string
  tier: AffiliateTierInfo
  totals: {
    clicks: number
    signups: number
    activeReferrals: number
    orders: number
    conversionPct: number
    level2Earned: number
  }
  earnings: ReferralSummary
  links: DashboardLink[]
  referrals: DashboardReferral[]
  feed: DashboardFeedItem[]
  generatedAt: string
}

export async function getAffiliateDashboard(userId: string): Promise<AffiliateDashboard> {
  const [tier, earnings, profile, codes, referrals, perReferred, level2, feedRows] = await Promise.all([
    getAffiliateTierInfo(userId),
    getReferralSummary(userId),
    db.gasAffiliate.findUnique({ where: { userId }, select: { status: true } }),
    db.gasReferralCode.findMany({ where: { ownerId: userId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    db.gasReferral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { referred: { select: { username: true } }, code: { select: { code: true, label: true } } },
    }),
    db.gasReferralAccrual.groupBy({
      by: ['referredId'],
      where: { referrerId: userId, level: 1 },
      _count: { _all: true },
      _sum: { amountUsdt: true, marginUsdt: true },
      _max: { createdAt: true },
    }),
    db.gasReferralAccrual.aggregate({ where: { referrerId: userId, level: 2 }, _sum: { amountUsdt: true } }),
    db.gasReferralAccrual.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' }, take: 15 }),
  ])

  const statsByReferred = new Map(perReferred.map((r) => [r.referredId, r]))

  // Per-link: sign-ups from the referral rows, orders/earned from the referred users' accruals.
  const linkAgg = new Map<string, { signups: number; orders: number; earned: number }>()
  for (const r of referrals) {
    const a = linkAgg.get(r.codeId) ?? { signups: 0, orders: 0, earned: 0 }
    a.signups += 1
    const st = statsByReferred.get(r.referredId)
    if (st) { a.orders += st._count._all; a.earned += num(st._sum.amountUsdt) }
    linkAgg.set(r.codeId, a)
  }

  const links: DashboardLink[] = codes.map((c, i) => {
    const a = linkAgg.get(c.id) ?? { signups: 0, orders: 0, earned: 0 }
    return {
      id: c.id, code: c.code, label: c.label, isActive: c.isActive, isPrimary: i === 0,
      clicks: c.clickCount, lastClickAt: c.lastClickAt ? c.lastClickAt.toISOString() : null,
      signups: a.signups, orders: a.orders, earnedUsdt: round2(a.earned),
    }
  })

  const referralRows: DashboardReferral[] = referrals.map((r) => {
    const st = statsByReferred.get(r.referredId)
    return {
      referredId: r.referredId,
      username: r.referred.username,
      joinedAt: r.createdAt.toISOString(),
      linkCode: r.code.code,
      linkLabel: r.code.label,
      orders: st?._count._all ?? 0,
      marginUsdt: round2(num(st?._sum.marginUsdt)),
      earnedUsdt: round2(num(st?._sum.amountUsdt)),
      lastOrderAt: st?._max.createdAt ? st._max.createdAt.toISOString() : null,
    }
  })

  // Feed usernames (level-2 rows reference people who are not in our direct list).
  const feedUserIds = [...new Set(feedRows.map((f) => f.referredId))]
  const feedUsers = feedUserIds.length
    ? await db.user.findMany({ where: { id: { in: feedUserIds } }, select: { id: true, username: true } })
    : []
  const nameById = new Map(feedUsers.map((u) => [u.id, u.username]))
  const feed: DashboardFeedItem[] = feedRows.map((f) => ({
    id: f.id, at: f.createdAt.toISOString(), level: f.level, amountUsdt: num(f.amountUsdt), pct: f.pct,
    username: nameById.get(f.referredId) ?? null, status: f.status,
  }))

  const clicks = links.reduce((s, l) => s + l.clicks, 0)
  const signups = referrals.length
  const activeReferrals = referralRows.filter((r) => r.orders > 0).length
  return {
    isAffiliate: profile?.status === 'approved',
    affiliateStatus: profile?.status ?? 'none',
    tier,
    totals: {
      clicks,
      signups,
      activeReferrals,
      orders: tier.orders,
      conversionPct: signups > 0 ? round2((activeReferrals / signups) * 100) : 0,
      level2Earned: round2(num(level2._sum.amountUsdt)),
    },
    earnings,
    links,
    referrals: referralRows,
    feed,
    generatedAt: new Date().toISOString(),
  }
}

/** Count one landing-page visit for a code (deduped per visitor by the caller). */
export async function recordReferralClick(rawCode: string): Promise<boolean> {
  const code = rawCode.trim().toUpperCase()
  if (!code || code.length > 40) return false
  const res = await db.gasReferralCode.updateMany({
    where: { code, deletedAt: null },
    data: { clickCount: { increment: 1 }, lastClickAt: new Date() },
  })
  return res.count > 0
}
