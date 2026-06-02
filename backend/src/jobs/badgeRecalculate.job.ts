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
  if (totalTrades >= 500 && rate >= 0.98) return { badge: 'elite', badgeLabel: 'Elite' }
  if (totalTrades >= 200 && rate >= 0.95) return { badge: 'top', badgeLabel: 'Diamond' }
  if (totalTrades >= 50 && rate >= 0.9) return { badge: 'trusted', badgeLabel: 'Gold' }
  if (totalTrades >= 5 && rate >= 0.8) return { badge: 'active', badgeLabel: 'Silver' }
  return { badge: 'new', badgeLabel: 'Bronze' }
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
    // Query all three trade sources in parallel — every trade on the platform counts
    const [usdtTrades, ctmTrades, gasOrders, userRow, usdtRatingAgg, ctmRatingAgg, usdtVolumeAgg, ctmVolumeAgg, gasVolumeAgg] =
      await Promise.all([
        db.trade.findMany({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
          select: { status: true },
        }),
        db.ctmTrade.findMany({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
          select: { status: true },
        }),
        db.gasFeeOrder.findMany({
          where: { userId },
          select: { status: true },
        }),
        db.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
        db.tradeRating.aggregate({
          where: { ratedUserId: userId },
          _avg: { rating: true },
          _count: { rating: true },
        }),
        db.ctmTradeRating.aggregate({
          where: { ratedUserId: userId },
          _avg: { rating: true },
          _count: { rating: true },
        }),
        db.trade.aggregate({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'crypto_released' },
          _sum: { fiatAmount: true },
        }),
        db.ctmTrade.aggregate({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'completed' },
          _sum: { fiatAmount: true },
        }),
        db.gasFeeOrder.aggregate({
          where: { userId, status: 'delivered' },
          _sum: { pkrAmount: true },
        }),
      ])

    const accountAgeDays = userRow
      ? (Date.now() - userRow.createdAt.getTime()) / 86_400_000
      : 0

    // Unified counts across USDT P2P + CTM + Gas
    const usdtCompleted = usdtTrades.filter((t) => t.status === 'crypto_released').length
    const usdtCancelled = usdtTrades.filter((t) => t.status === 'cancelled').length
    const ctmCompleted = ctmTrades.filter((t) => t.status === 'completed').length
    const ctmCancelled = ctmTrades.filter((t) => t.status === 'cancelled').length
    const gasCompleted = gasOrders.filter((o) => o.status === 'delivered').length

    const total = usdtTrades.length + ctmTrades.length + gasOrders.length
    const completed = usdtCompleted + ctmCompleted + gasCompleted
    const cancelled = usdtCancelled + ctmCancelled
    const completionRate = total > 0 ? completed / total : 0

    // Combined ratings: weighted average of USDT TradeRating + CTM CtmTradeRating
    const usdtRatingCount = usdtRatingAgg._count.rating
    const ctmRatingCount = ctmRatingAgg._count.rating
    const totalReviews = usdtRatingCount + ctmRatingCount
    const avgRating =
      totalReviews > 0
        ? (Number(usdtRatingAgg._avg.rating ?? 0) * usdtRatingCount +
            Number(ctmRatingAgg._avg.rating ?? 0) * ctmRatingCount) /
          totalReviews
        : 0

    // Combined PKR volume across all three sources
    const totalVolumePKR = new Prisma.Decimal(
      Number(usdtVolumeAgg._sum.fiatAmount ?? 0) +
        Number(ctmVolumeAgg._sum.fiatAmount ?? 0) +
        Number(gasVolumeAgg._sum.pkrAmount ?? 0),
    )

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
          ? `Congratulations! You've reached ${badgeLabel} tier.`
          : `Your trader tier changed to ${badgeLabel}. Maintain your completion rate to upgrade.`,
        { badge, previousBadge: current.badge },
      )
    }

    logger.info({ userId, badge, completionRate, trustScore }, 'Badge recalculated')
  } catch (err) {
    logger.error({ err, userId }, 'Failed to recalculate badge')
    throw err
  }
}
