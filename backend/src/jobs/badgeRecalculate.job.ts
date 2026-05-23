// Called after each trade completes. Updates TradeStats and badge.
// Also creates notification if badge changed.

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { Prisma } from '@prisma/client'
import { notify } from '../lib/notify'

function computeBadge(
  totalTrades: number,
  completionRate: number,
): { badge: string; badgeLabel: string } {
  const rate = Number(completionRate)
  if (totalTrades >= 500 && rate >= 0.98) return { badge: 'elite', badgeLabel: 'Elite Trader' }
  if (totalTrades >= 200 && rate >= 0.95) return { badge: 'top', badgeLabel: 'Top Trader' }
  if (totalTrades >= 50 && rate >= 0.9) return { badge: 'trusted', badgeLabel: 'Trusted Trader' }
  if (totalTrades >= 5 && rate >= 0.8) return { badge: 'active', badgeLabel: 'Active Trader' }
  return { badge: 'new', badgeLabel: 'New Trader' }
}

function computeTrustScore(
  completionRate: number,
  avgRating: number,
  totalTrades: number,
  accountAgeDays: number,
): number {
  const cr = Number(completionRate)
  const ar = Number(avgRating)
  const ageFactor = Math.min(accountAgeDays / 90, 1) // ramps 0→1 over first 90 days
  const score =
    cr * 0.50 +
    (ar / 5) * 0.30 +
    (Math.log10(totalTrades + 1) / Math.log10(1001)) * 0.15 +
    ageFactor * 0.05
  return Math.round(score * 100) // 0-100 integer
}

const BADGE_ORDER = ['new', 'active', 'trusted', 'top', 'elite']

export async function recalculateUserBadge(userId: string): Promise<void> {
  try {
    const [trades, userRow] = await Promise.all([
      db.trade.findMany({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
        select: { status: true },
      }),
      db.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    ])

    const accountAgeDays = userRow
      ? (Date.now() - userRow.createdAt.getTime()) / 86_400_000
      : 0

    const total = trades.length
    const completed = trades.filter((t) => t.status === 'crypto_released').length
    const cancelled = trades.filter((t) => t.status === 'cancelled').length
    const completionRate = total > 0 ? completed / total : 0

    // Get average rating
    const ratingAgg = await db.tradeRating.aggregate({
      where: { ratedUserId: userId },
      _avg: { rating: true },
      _count: { rating: true },
    })
    const avgRating = Number(ratingAgg._avg.rating ?? 0)
    const totalReviews = ratingAgg._count.rating

    // Get volume
    const volumeAgg = await db.trade.aggregate({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: 'crypto_released',
      },
      _sum: { fiatAmount: true },
    })
    const totalVolumePKR = volumeAgg._sum.fiatAmount ?? new Prisma.Decimal(0)

    const { badge, badgeLabel } = computeBadge(completed, completionRate)
    const trustScore = computeTrustScore(completionRate, avgRating, completed, accountAgeDays)

    // Get current stats to check for badge change and respect admin override
    const current = await db.tradeStats.findUnique({
      where: { userId },
      select: { badge: true, badgeOverride: true },
    })

    const statsUpdate = {
      totalTrades: total,
      completedTrades: completed,
      cancelledTrades: cancelled,
      completionRate: new Prisma.Decimal(completionRate),
      avgRating: new Prisma.Decimal(avgRating),
      totalReviews,
      totalVolumePKR,
      trustScore,
      // Only write computed badge if no admin override is active
      ...(current?.badgeOverride ? {} : {
        badge: badge as 'new' | 'active' | 'trusted' | 'top' | 'elite',
        badgeLabel,
      }),
    }

    await db.tradeStats.upsert({
      where: { userId },
      create: {
        userId,
        ...statsUpdate,
        // New rows always start with computed badge
        badge: badge as 'new' | 'active' | 'trusted' | 'top' | 'elite',
        badgeLabel,
      },
      update: statsUpdate,
    })

    // Notify on badge change (skip if admin has locked the badge)
    if (current && !current.badgeOverride && current.badge !== badge) {
      const direction =
        BADGE_ORDER.indexOf(badge) > BADGE_ORDER.indexOf(current.badge) ? 'upgraded' : 'downgraded'

      notify(
        userId,
        direction === 'upgraded' ? 'badge_upgraded' : 'badge_downgraded',
        direction === 'upgraded' ? `Badge upgraded to ${badgeLabel}!` : `Your badge changed to ${badgeLabel}`,
        direction === 'upgraded'
          ? `Congratulations! You've earned the ${badgeLabel} badge.`
          : `Your trader badge has changed to ${badgeLabel}. Maintain your completion rate to upgrade.`,
        { badge, previousBadge: current.badge },
      )
    }

    logger.info({ userId, badge, completionRate, trustScore }, 'Badge recalculated')
  } catch (err) {
    logger.error({ err, userId }, 'Failed to recalculate badge')
    throw err
  }
}
