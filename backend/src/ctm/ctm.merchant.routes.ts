import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'

type JsonValue = Prisma.InputJsonValue

const updateSettlementSchema = z.object({
  instructions: z.record(z.object({
    method: z.string().min(1).max(100),
    instructions: z.string().min(1).max(500),
  })),
})

const suspendSchema = z.object({
  reason: z.string().min(1).max(500),
  suspendUntil: z.string().datetime().optional(),
})

export async function ctmMerchantRoutes(app: FastifyInstance) {
  // GET /ctm/merchants/me — get own CTM profile
  app.get('/ctm/merchants/me', { preHandler: [authenticate] }, async (req, reply) => {
    const profile = await db.ctmMerchantProfile.findUnique({
      where: { userId: req.user!.id },
      include: {
        listings: {
          where: { status: 'active' },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { token: { select: { id: true, name: true, symbol: true, logoUrl: true } } },
        },
      },
    })
    return reply.send({ success: true, data: profile })
  })

  // POST /ctm/merchants/register — register as CTM merchant
  app.post('/ctm/merchants/register', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const existing = await db.ctmMerchantProfile.findUnique({ where: { userId } })
    if (existing) throw new AppError('CONFLICT', 'You already have a CTM merchant profile', 409)

    const merchant = await db.merchant.findUnique({ where: { userId } })
    if (!merchant) throw new AppError('FORBIDDEN', 'You must be an approved merchant to register as CTM merchant', 403)
    if (merchant.status !== 'approved') throw new AppError('FORBIDDEN', 'Your merchant account must be approved', 403)

    const profile = await db.ctmMerchantProfile.create({
      data: {
        userId,
        merchantId: merchant.id,
        settlementInstructions: {} as JsonValue,
        isActive: false,
      },
    })
    return reply.code(201).send({ success: true, data: profile })
  })

  // PATCH /ctm/merchants/me/settlement — update settlement instructions
  app.patch('/ctm/merchants/me/settlement', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = updateSettlementSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const profile = await db.ctmMerchantProfile.findUnique({ where: { userId: req.user!.id } })
    if (!profile) throw new AppError('NOT_FOUND', 'CTM merchant profile not found', 404)

    const updated = await db.ctmMerchantProfile.update({
      where: { userId: req.user!.id },
      data: { settlementInstructions: parsed.data.instructions as JsonValue },
    })
    return reply.send({ success: true, data: updated })
  })

  // GET /ctm/merchants/:userId/public — public profile (incl. ratings)
  app.get('/ctm/merchants/:userId/public', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const profile = await db.ctmMerchantProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true, username: true, fullName: true, avatarUrl: true,
            merchant: { select: { businessName: true, status: true } },
          },
        },
        listings: {
          where: { status: 'active' },
          take: 10,
          include: { token: { select: { id: true, name: true, symbol: true, logoUrl: true, slug: true } } },
        },
      },
    })
    if (!profile || !profile.isActive) throw new AppError('NOT_FOUND', 'CTM merchant not found', 404)

    const ratings = await db.ctmTradeRating.findMany({
      where: { ratedUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { trade: { select: { tradeRef: true } } },
    })

    const raterIds = [...new Set(ratings.map((r) => r.ratedByUserId))]
    const raters = await db.user.findMany({
      where: { id: { in: raterIds } },
      select: { id: true, username: true, fullName: true, avatarUrl: true },
    })
    const raterMap = new Map(raters.map((u) => [u.id, u]))

    const reviews = ratings.map((r) => {
      const rater = raterMap.get(r.ratedByUserId)
      return {
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        tags: r.tags,
        createdAt: r.createdAt,
        raterUsername: rater?.username ?? 'anonymous',
        raterFullName: rater?.fullName ?? null,
        raterAvatarUrl: rater?.avatarUrl ?? null,
        tradeRef: r.trade?.tradeRef ?? null,
      }
    })

    // Whether the authenticated viewer has favorited this trader (same generic
    // UserFavorite used on the USDT profile page — favorites are cross-market).
    const viewerId = (req as { user?: { id: string } }).user?.id
    const isFavorited = viewerId && viewerId !== userId
      ? !!(await db.userFavorite.findUnique({
          where: { userId_favoritedUserId: { userId: viewerId, favoritedUserId: userId } },
        }))
      : false

    return reply.send({ success: true, data: { ...profile, reviews, isFavorited } })
  })

  // GET /ctm/merchants/admin/queue — pending CTM merchant approvals
  app.get('/ctm/merchants/admin/queue', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page = q.page ? parseInt(q.page, 10) : 1
    const limit = q.limit ? parseInt(q.limit, 10) : 20
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = q.tier ? { tier: q.tier } : {}
    if (q.status === 'pending') where.approvedAt = null

    const [merchants, total] = await Promise.all([
      db.ctmMerchantProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, email: true } },
          merchant: { select: { id: true, status: true } },
        },
      }),
      db.ctmMerchantProfile.count({ where }),
    ])

    return reply.send({ success: true, data: { merchants, total, page, limit } })
  })

  // POST /ctm/merchants/admin/:id/approve — approve CTM merchant
  app.post('/ctm/merchants/admin/:id/approve', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { tier?: string } | null
    const tier = (body as Record<string, unknown>)?.tier as string | undefined

    const profile = await db.ctmMerchantProfile.findUnique({ where: { id } })
    if (!profile) throw new AppError('NOT_FOUND', 'CTM merchant profile not found', 404)

    const updated = await db.ctmMerchantProfile.update({
      where: { id },
      data: {
        approvedAt: new Date(),
        approvedBy: req.user!.id,
        isActive: true,
        ...(tier ? { tier: tier as never } : {}),
      },
    })
    return reply.send({ success: true, data: updated })
  })

  // PATCH /ctm/merchants/admin/:id/tier — change merchant tier
  app.patch('/ctm/merchants/admin/:id/tier', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { tier?: string } | null
    const tier = (body as Record<string, unknown>)?.tier as string | undefined
    if (!tier || !['new', 'basic', 'verified', 'elite'].includes(tier)) {
      throw new AppError('VALIDATION_ERROR', 'tier must be one of: new, basic, verified, elite', 400)
    }

    const profile = await db.ctmMerchantProfile.findUnique({ where: { id } })
    if (!profile) throw new AppError('NOT_FOUND', 'CTM merchant profile not found', 404)

    const updated = await db.ctmMerchantProfile.update({
      where: { id },
      data: { tier: tier as never },
    })

    await db.auditLog.create({
      data: { actorId: req.user!.id, action: 'CTM_MERCHANT_TIER_CHANGED', metadata: { profileId: id, newTier: tier } as JsonValue },
    }).catch(() => {})

    return reply.send({ success: true, data: updated })
  })

  // POST /ctm/merchants/admin/:id/suspend — suspend CTM merchant
  app.post('/ctm/merchants/admin/:id/suspend', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = suspendSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const profile = await db.ctmMerchantProfile.findUnique({ where: { id } })
    if (!profile) throw new AppError('NOT_FOUND', 'CTM merchant profile not found', 404)

    const updated = await db.ctmMerchantProfile.update({
      where: { id },
      data: {
        isActive: false,
        suspendReason: parsed.data.reason,
        suspendedUntil: parsed.data.suspendUntil ? new Date(parsed.data.suspendUntil) : null,
      },
    })

    await db.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: 'CTM_MERCHANT_SUSPENDED',
        metadata: { profileId: id, reason: parsed.data.reason } as JsonValue,
      },
    }).catch(() => {})

    return reply.send({ success: true, data: updated })
  })
}
