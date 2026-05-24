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

  // ─── User Rank ─────────────────────────────────────────────────────────────

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
