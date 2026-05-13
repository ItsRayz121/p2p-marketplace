import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'

export async function userRoutes(app: FastifyInstance) {
  // GET /api/users/:username/profile — public (optional auth)
  app.get('/users/:username/profile', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { username } = req.params as { username: string }

    const user = await db.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        kycStatus: true,
        kycLevel: true,
        createdAt: true,
        lastSeenAt: true,
        socialLinks: true,
        socialLinksPublic: true,
        tradeStats: true,
        merchant: {
          select: {
            id: true,
            businessName: true,
            status: true,
            rank: true,
            spreadBps: true,
          },
        },
      },
    })

    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)

    // Fetch last 10 ratings where this user was rated
    const ratings = await db.tradeRating.findMany({
      where: { ratedUserId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        rating: true,
        comment: true,
        tags: true,
        createdAt: true,
        ratedByUserId: true,
        trade: {
          select: {
            orderRef: true,
            coin: true,
          },
        },
      },
    })

    // Enrich ratings with reviewer username (selective, avoid full user join)
    const reviewerIds = [...new Set(ratings.map((r) => r.ratedByUserId))]
    const reviewers = await db.user.findMany({
      where: { id: { in: reviewerIds } },
      select: { id: true, username: true },
    })
    const reviewerMap = Object.fromEntries(reviewers.map((u) => [u.id, u.username]))

    const enrichedRatings = ratings.map((r) => ({
      ...r,
      reviewerUsername: reviewerMap[r.ratedByUserId] ?? 'Unknown',
    }))

    // Hide social links if user has opted out
    const profile = {
      ...user,
      socialLinks: user.socialLinksPublic ? user.socialLinks : null,
      ratings: enrichedRatings,
    }

    return reply.send({ success: true, data: profile })
  })

  // GET /api/users/me/rank — authenticated
  app.get('/users/me/rank', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const stats = await db.tradeStats.findUnique({ where: { userId } })

    // Badge tier thresholds for progress display
    const BADGE_THRESHOLDS = {
      new: { minTrades: 0, label: 'New Trader' },
      active: { minTrades: 5, label: 'Active Trader' },
      trusted: { minTrades: 25, label: 'Trusted Trader' },
      top: { minTrades: 100, label: 'Top Trader' },
      elite: { minTrades: 500, label: 'Elite Trader' },
    } as const

    const completedTrades = stats?.completedTrades ?? 0

    // Determine next badge
    const tiers = Object.entries(BADGE_THRESHOLDS) as Array<[string, { minTrades: number; label: string }]>
    const currentTierIndex = tiers.reduce((best, [, tier], idx) => {
      return completedTrades >= tier.minTrades ? idx : best
    }, 0)
    const nextTier = tiers[currentTierIndex + 1]

    return reply.send({
      success: true,
      data: {
        stats,
        badge: stats?.badge ?? 'new',
        badgeLabel: stats?.badgeLabel ?? 'New Trader',
        thresholds: BADGE_THRESHOLDS,
        nextBadge: nextTier
          ? {
              badge: nextTier[0],
              label: nextTier[1].label,
              requiredTrades: nextTier[1].minTrades,
              tradesNeeded: Math.max(0, nextTier[1].minTrades - completedTrades),
            }
          : null,
      },
    })
  })
}
