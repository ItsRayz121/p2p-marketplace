import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../lib/prisma'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'

const PAYMENT_METHOD_TYPES = ['jazzcash', 'easypaisa', 'sadapay', 'nayapay', 'bank_transfer'] as const

const paymentMethodSchema = z.object({
  type: z.enum(PAYMENT_METHOD_TYPES),
  displayName: z.string().min(1).max(100),
  accountName: z.string().min(1).max(100),
  mobileNumber: z.string().max(20).optional(),
  bankName: z.string().max(100).optional(),
  ibanNumber: z.string().max(34).optional(),
  accountNumber: z.string().max(30).optional(),
})

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
        isEmailVerified: true,
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
        ads: {
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true, side: true, coin: true, network: true,
            price: true, minOrder: true, maxOrder: true,
            availableAmount: true, paymentMethods: true, tradeWindow: true,
          },
        },
      },
    })

    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)

    // Check if the authenticated viewer has favorited this trader
    const viewerId = (req as { user?: { id: string } }).user?.id
    const isFavorited = viewerId && viewerId !== user.id
      ? !!(await db.userFavorite.findUnique({
          where: { userId_favoritedUserId: { userId: viewerId, favoritedUserId: user.id } },
        }))
      : false

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
      verifiedEmail: user.isEmailVerified,
      isFavorited,
      socialLinks: user.socialLinksPublic ? user.socialLinks : null,
      ratings: enrichedRatings,
      activeAds: user.ads.map((ad) => ({
        ...ad,
        price: ad.price.toString(),
        minOrder: ad.minOrder.toString(),
        maxOrder: ad.maxOrder.toString(),
        availableAmount: ad.availableAmount.toString(),
      })),
    }

    return reply.send({ success: true, data: profile })
  })

  // ─── Payment Methods CRUD ────────────────────────────────────────────────────

  // GET /api/users/me/payment-methods
  app.get('/users/me/payment-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const methods = await db.paymentMethod.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ success: true, data: methods })
  })

  // POST /api/users/me/payment-methods
  app.post('/users/me/payment-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = paymentMethodSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { type, displayName, accountName, mobileNumber, bankName, ibanNumber, accountNumber } = parsed.data

    const count = await db.paymentMethod.count({ where: { userId, isActive: true } })
    if (count >= 10) throw new AppError('LIMIT_EXCEEDED', 'Maximum 10 payment methods allowed', 400)

    const method = await db.paymentMethod.create({
      data: {
        userId, type, displayName, accountName,
        ...(mobileNumber ? { mobileNumber } : {}),
        ...(bankName ? { bankName } : {}),
        ...(ibanNumber ? { ibanNumber } : {}),
        ...(accountNumber ? { accountNumber } : {}),
      },
    })
    return reply.code(201).send({ success: true, data: method })
  })

  // DELETE /api/users/me/payment-methods/:id
  app.delete('/users/me/payment-methods/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const method = await db.paymentMethod.findUnique({ where: { id } })
    if (!method || method.userId !== userId) throw new AppError('NOT_FOUND', 'Payment method not found', 404)
    await db.paymentMethod.update({ where: { id }, data: { isActive: false } })
    return reply.send({ success: true, data: null })
  })

  // ─── Favorites ────────────────────────────────────────────────────────────────

  // POST /api/users/:username/favorite — add trader to favorites
  app.post('/users/:username/favorite', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { username } = req.params as { username: string }

    const target = await db.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) throw new AppError('NOT_FOUND', 'User not found', 404)
    if (target.id === userId) throw new AppError('VALIDATION_ERROR', 'Cannot favorite yourself', 400)

    await db.userFavorite.upsert({
      where: { userId_favoritedUserId: { userId, favoritedUserId: target.id } },
      create: { userId, favoritedUserId: target.id },
      update: {},
    })
    return reply.send({ success: true, data: { isFavorited: true } })
  })

  // DELETE /api/users/:username/favorite — remove from favorites
  app.delete('/users/:username/favorite', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { username } = req.params as { username: string }

    const target = await db.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) throw new AppError('NOT_FOUND', 'User not found', 404)

    await db.userFavorite.deleteMany({ where: { userId, favoritedUserId: target.id } })
    return reply.send({ success: true, data: { isFavorited: false } })
  })

  // GET /api/users/me/favorites — list my favorited traders + their active ads
  app.get('/users/me/favorites', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const favs = await db.userFavorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        favOf: {
          select: {
            id: true,
            username: true,
            lastSeenAt: true,
            tradeStats: {
              select: {
                badge: true,
                completedTrades: true,
                completionRate: true,
                avgRating: true,
                avgResponseMinutes: true,
              },
            },
            merchant: { select: { id: true, status: true } },
            ads: {
              where: { status: 'active' },
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: {
                id: true, side: true, coin: true, price: true,
                availableAmount: true, minOrder: true, maxOrder: true, paymentMethods: true,
              },
            },
          },
        },
      },
    })

    return reply.send({
      success: true,
      data: favs.map((f) => ({
        favoritedAt: f.createdAt,
        trader: {
          ...f.favOf,
          lastSeenAt: f.favOf.lastSeenAt?.toISOString() ?? null,
          ads: (f.favOf.ads as Array<{ id: string; side: string; coin: string; price: { toString(): string }; availableAmount: { toString(): string }; minOrder: { toString(): string }; maxOrder: { toString(): string }; paymentMethods: string[] }>).map((ad) => ({
            ...ad,
            price: ad.price.toString(),
            availableAmount: ad.availableAmount.toString(),
            minOrder: ad.minOrder.toString(),
            maxOrder: ad.maxOrder.toString(),
          })),
        },
      })),
    })
  })

  // ─── User Rank ─────────────────────────────────────────────────────────────

  // GET /api/users/me/rank — authenticated
  app.get('/users/me/rank', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const stats = await db.tradeStats.findUnique({ where: { userId } })

    // Badge tier thresholds for progress display
    const BADGE_THRESHOLDS = {
      new: { minTrades: 0, label: 'Bronze' },
      active: { minTrades: 5, label: 'Silver' },
      trusted: { minTrades: 50, label: 'Gold' },
      top: { minTrades: 200, label: 'Diamond' },
      elite: { minTrades: 500, label: 'Elite' },
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
