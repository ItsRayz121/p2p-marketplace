// Called after each trade completes. Updates TradeStats and badge.
// Also creates notification if badge changed.

import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { Prisma } from '@prisma/client'

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
): number {
  const cr = Number(completionRate)
  const ar = Number(avgRating)
  const score =
    cr * 0.5 +
    (ar / 5) * 0.3 +
    (Math.log10(totalTrades + 1) / Math.log10(1001)) * 0.2
  return Math.round(score * 100) // 0-100 integer
}

const BADGE_ORDER = ['new', 'active', 'trusted', 'top', 'elite']

export async function recalculateUserBadge(userId: string): Promise<void> {
  try {
    // Get all completed/cancelled trades for this user
    const trades = await db.trade.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      select: { status: true },
    })

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
    const trustScore = computeTrustScore(completionRate, avgRating, completed)

    // Get current badge to check for change
    const current = await db.tradeStats.findUnique({
      where: { userId },
      select: { badge: true },
    })

    await db.tradeStats.upsert({
      where: { userId },
      create: {
        userId,
        totalTrades: total,
        completedTrades: completed,
        cancelledTrades: cancelled,
        completionRate: new Prisma.Decimal(completionRate),
        avgRating: new Prisma.Decimal(avgRating),
        totalReviews,
        totalVolumePKR,
        trustScore,
        badge: badge as 'new' | 'active' | 'trusted' | 'top' | 'elite',
        badgeLabel,
      },
      update: {
        totalTrades: total,
        completedTrades: completed,
        cancelledTrades: cancelled,
        completionRate: new Prisma.Decimal(completionRate),
        avgRating: new Prisma.Decimal(avgRating),
        totalReviews,
        totalVolumePKR,
        trustScore,
        badge: badge as 'new' | 'active' | 'trusted' | 'top' | 'elite',
        badgeLabel,
      },
    })

    // Notify on badge change
    if (current && current.badge !== badge) {
      const direction =
        BADGE_ORDER.indexOf(badge) > BADGE_ORDER.indexOf(current.badge) ? 'upgraded' : 'downgraded'

      await db.notification.create({
        data: {
          userId,
          title:
            direction === 'upgraded'
              ? `🏅 Badge upgraded to ${badgeLabel}!`
              : `Your badge changed to ${badgeLabel}`,
          body:
            direction === 'upgraded'
              ? `Congratulations! You've earned the ${badgeLabel} badge.`
              : `Your trader badge has changed to ${badgeLabel}. Maintain your completion rate to upgrade.`,
          type: direction === 'upgraded' ? 'badge_upgraded' : 'badge_downgraded',
          metadata: { badge, previousBadge: current.badge },
        },
      })
    }

    logger.info({ userId, badge, completionRate, trustScore }, 'Badge recalculated')
  } catch (err) {
    logger.error({ err, userId }, 'Failed to recalculate badge')
    throw err
  }
}
