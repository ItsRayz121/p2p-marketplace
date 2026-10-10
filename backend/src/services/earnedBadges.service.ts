/**
 * Earned achievement badges — awarded automatically from real activity, never bought.
 * Computed on demand (no stored state) so they can't drift from the underlying data
 * and a rule change applies immediately. Positive signals only: nobody is shown a
 * negative badge, in line with the neutral-disputes product decision.
 */
import { db } from '../lib/prisma'
import { EARLY_MEMBER_LIMIT, evaluateEarnedBadges, type EarnedBadge } from './earnedBadges.rules'

export * from './earnedBadges.rules'

// Signup date of the EARLY_MEMBER_LIMIT-th member. Cached in-process for an hour so a
// profile view never sorts or counts the whole users table. null = fewer members than
// the limit, so everyone is still early.
let cutoffCache: { value: Date | null; at: number } | null = null
async function getEarlyCutoff(): Promise<Date | null> {
  if (cutoffCache && Date.now() - cutoffCache.at < 3_600_000) return cutoffCache.value
  const row = await db.user.findMany({ orderBy: { createdAt: 'asc' }, skip: EARLY_MEMBER_LIMIT - 1, take: 1, select: { createdAt: true } })
  cutoffCache = { value: row[0]?.createdAt ?? null, at: Date.now() }
  return cutoffCache.value
}

export async function getEarnedBadges(userId: string): Promise<EarnedBadge[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      createdAt: true,
      kycStatus: true,
      tradeStats: { select: { completedTrades: true, avgReleaseMinutes: true, disputesLost: true } },
    },
  })
  if (!user) return []

  const [gasByChain, cutoff, affiliate] = await Promise.all([
    db.gasFeeOrder.groupBy({ by: ['chain'], where: { userId, status: 'delivered' }, _count: { _all: true } }),
    getEarlyCutoff(),
    db.gasAffiliate.findUnique({ where: { userId }, select: { status: true } }),
  ])

  return evaluateEarnedBadges(
    {
      userId,
      createdAt: user.createdAt,
      kycApproved: user.kycStatus === 'approved',
      completedTrades: user.tradeStats?.completedTrades ?? 0,
      avgReleaseMinutes: user.tradeStats?.avgReleaseMinutes ?? null,
      disputesLost: user.tradeStats?.disputesLost ?? 0,
    },
    {
      gasDelivered: gasByChain.reduce((s, g) => s + g._count._all, 0),
      gasChains: gasByChain.length,
      earlyMember: cutoff === null || user.createdAt <= cutoff,
      affiliateApproved: affiliate?.status === 'approved',
    },
  )
}
