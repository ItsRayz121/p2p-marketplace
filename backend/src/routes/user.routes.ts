import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../lib/prisma'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { namesMatch } from '../lib/identity'
import { recordAuditLog } from '../lib/audit'
import {
  getSocialProfile, addSocialLink, setSocialLinkHidden, deleteSocialLink, setSocialPublic, parseSocialLinks,
} from '../services/socialLinks.service'

const PAYMENT_METHOD_TYPES = ['jazzcash', 'easypaisa', 'sadapay', 'nayapay', 'bank_transfer'] as const

/** Mask an account/IBAN/mobile for audit metadata — keep only the last 4 digits. */
function maskAccount(v: string | null | undefined): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (s.length <= 4) return '••••'
  return `••••${s.slice(-4)}`
}

const paymentMethodSchema = z.object({
  type: z.enum(PAYMENT_METHOD_TYPES),
  displayName: z.string().min(1).max(100),
  accountName: z.string().min(1).max(100),
  mobileNumber: z.string().max(20).optional(),
  bankName: z.string().max(100).optional(),
  ibanNumber: z.string().max(34).optional(),
  accountNumber: z.string().max(30).optional(),
})

// Edit an existing method: account holder name + the number fields. Type/bank
// are fixed once created (a different bank/rail is a different method).
const paymentMethodEditSchema = z.object({
  accountName: z.string().min(1).max(100).optional(),
  mobileNumber: z.string().max(20).optional(),
  ibanNumber: z.string().max(34).optional(),
  accountNumber: z.string().max(30).optional(),
})

const visibilitySchema = z.object({ hidden: z.boolean() })

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
        avatarUrl: true,
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
      select: { id: true, username: true, fullName: true, avatarUrl: true },
    })
    const reviewerMap = Object.fromEntries(reviewers.map((u) => [u.id, { username: u.username, fullName: u.fullName, avatarUrl: u.avatarUrl }]))

    const enrichedRatings = ratings.map((r) => ({
      ...r,
      reviewerUsername: reviewerMap[r.ratedByUserId]?.username ?? 'Unknown',
      reviewerFullName: reviewerMap[r.ratedByUserId]?.fullName ?? null,
      reviewerAvatarUrl: reviewerMap[r.ratedByUserId]?.avatarUrl ?? null,
    }))

    // Resolve payment method IDs (stored as record cuids on the ad) to their
    // human method type so the public profile never leaks internal IDs.
    const allPmIds = [...new Set(user.ads.flatMap((ad) => ad.paymentMethods))]
    const pmTypeMap = new Map<string, string>()
    if (allPmIds.length > 0) {
      const pms = await db.paymentMethod.findMany({
        where: { id: { in: allPmIds } },
        select: { id: true, type: true },
      })
      for (const pm of pms) pmTypeMap.set(pm.id, pm.type)
    }

    // The trader's full name is shown on their public profile (product decision):
    // both the header name and the reviewer names in the reviews list display the
    // real full name rather than a masked initials form.
    // Hide social links if user has opted out
    const profile = {
      ...user,
      fullName: user.fullName,
      verifiedEmail: user.isEmailVerified,
      isFavorited,
      // Public profile shows only non-hidden links, and only when opted in.
      socialLinks: user.socialLinksPublic
        ? parseSocialLinks(user.socialLinks).filter((l) => !l.hidden).map((l) => ({ platform: l.platform, url: l.url, verified: l.verified }))
        : null,
      // Reviews display the reviewer's full name and link to their public profile.
      ratings: enrichedRatings,
      activeAds: user.ads.map((ad) => ({
        ...ad,
        price: ad.price.toString(),
        minOrder: ad.minOrder.toString(),
        maxOrder: ad.maxOrder.toString(),
        availableAmount: ad.availableAmount.toString(),
        // Resolve to method type; drop any unresolved cuids rather than show them.
        paymentMethods: [...new Set(
          ad.paymentMethods
            .map((id) => pmTypeMap.get(id))
            .filter((v): v is string => Boolean(v)),
        )],
      })),
    }

    return reply.send({ success: true, data: profile })
  })

  // ─── Payment Methods CRUD ────────────────────────────────────────────────────

  // GET /api/users/me/payment-methods?includeHidden=1
  // Wallet management passes includeHidden=1 so hidden methods can be un-hidden;
  // any picker calling without the flag gets only visible methods.
  app.get('/users/me/payment-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const includeHidden = (req.query as { includeHidden?: string }).includeHidden === '1'
    const methods = await db.paymentMethod.findMany({
      where: { userId, isActive: true, ...(includeHidden ? {} : { hidden: false }) },
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

    // Non-custodial anti-fraud: the payment account holder name must match the
    // user's verified CNIC legal name — kills third-party-payment scams. Only
    // enforced once the name is locked (legalNameLockedAt) and the flag is ON.
    if (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)) {
      const u = await db.user.findUnique({ where: { id: userId }, select: { fullName: true, legalNameLockedAt: true } })
      if (u?.legalNameLockedAt && !namesMatch(accountName, u.fullName)) {
        throw new AppError(
          'NAME_MISMATCH',
          'The account holder name must match your verified CNIC name. Third-party accounts are not allowed.',
          400,
        )
      }
    }

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
    // Audit trail: preserve every payment-method change for the admin user
    // history (account numbers stored masked — last 4 digits only).
    void recordAuditLog(userId, 'PAYMENT_METHOD_ADDED', 'PaymentMethod', method.id, {
      type, displayName, accountName,
      bankName: bankName ?? null,
      mobileNumber: maskAccount(mobileNumber),
      ibanNumber: maskAccount(ibanNumber),
      accountNumber: maskAccount(accountNumber),
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
    // Audit trail: record the removal (soft-delete) for the admin user history.
    void recordAuditLog(userId, 'PAYMENT_METHOD_REMOVED', 'PaymentMethod', method.id, {
      type: method.type,
      displayName: method.displayName,
      accountName: method.accountName,
      bankName: method.bankName ?? null,
      mobileNumber: maskAccount(method.mobileNumber),
      ibanNumber: maskAccount(method.ibanNumber),
      accountNumber: maskAccount(method.accountNumber),
    })
    return reply.send({ success: true, data: null })
  })

  // PATCH /api/users/me/payment-methods/:id — edit account holder name / numbers
  app.patch('/users/me/payment-methods/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = paymentMethodEditSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const method = await db.paymentMethod.findUnique({ where: { id } })
    if (!method || method.userId !== userId || !method.isActive) {
      throw new AppError('NOT_FOUND', 'Payment method not found', 404)
    }
    const { accountName, mobileNumber, ibanNumber, accountNumber } = parsed.data

    // Non-custodial anti-fraud: an edited holder name must still match the verified
    // CNIC legal name once it is locked (parity with the add endpoint).
    if (accountName !== undefined && await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)) {
      const u = await db.user.findUnique({ where: { id: userId }, select: { fullName: true, legalNameLockedAt: true } })
      if (u?.legalNameLockedAt && !namesMatch(accountName, u.fullName)) {
        throw new AppError('NAME_MISMATCH', 'The account holder name must match your verified CNIC name. Third-party accounts are not allowed.', 400)
      }
    }

    const next = {
      accountName: accountName ?? method.accountName,
      mobileNumber: mobileNumber === undefined ? method.mobileNumber : (mobileNumber || null),
      ibanNumber: ibanNumber === undefined ? method.ibanNumber : (ibanNumber || null),
      accountNumber: accountNumber === undefined ? method.accountNumber : (accountNumber || null),
    }
    const updated = await db.paymentMethod.update({ where: { id }, data: next })
    // Audit trail: before → after, account numbers masked to last 4 digits.
    void recordAuditLog(userId, 'PAYMENT_METHOD_EDITED', 'PaymentMethod', id, {
      type: method.type,
      before: { accountName: method.accountName, mobileNumber: maskAccount(method.mobileNumber), ibanNumber: maskAccount(method.ibanNumber), accountNumber: maskAccount(method.accountNumber) },
      after: { accountName: next.accountName, mobileNumber: maskAccount(next.mobileNumber), ibanNumber: maskAccount(next.ibanNumber), accountNumber: maskAccount(next.accountNumber) },
    })
    return reply.send({ success: true, data: updated })
  })

  // PATCH /api/users/me/payment-methods/:id/visibility — hide / un-hide
  app.patch('/users/me/payment-methods/:id/visibility', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = visibilitySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    const method = await db.paymentMethod.findUnique({ where: { id } })
    if (!method || method.userId !== userId || !method.isActive) {
      throw new AppError('NOT_FOUND', 'Payment method not found', 404)
    }
    const updated = await db.paymentMethod.update({ where: { id }, data: { hidden: parsed.data.hidden } })
    void recordAuditLog(userId, parsed.data.hidden ? 'PAYMENT_METHOD_HIDDEN' : 'PAYMENT_METHOD_UNHIDDEN', 'PaymentMethod', id, {
      type: method.type, displayName: method.displayName, accountName: method.accountName,
    })
    return reply.send({ success: true, data: updated })
  })

  // ─── Social profile links ───────────────────────────────────────────────────
  // Source of truth for a user's social profiles. KYC-approved links are marked
  // `verified` (hide-only); the user may add their own extra links and choose to
  // show the set publicly on their profile.

  // GET /api/users/me/social-links → { links, public }
  app.get('/users/me/social-links', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await getSocialProfile(req.user!.id)
    return reply.send({ success: true, data })
  })

  const addSocialSchema = z.object({
    platform: z.string().min(1).max(40),
    url: z.string().url().max(300),
  })

  // POST /api/users/me/social-links — add a user-supplied link
  app.post('/users/me/social-links', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = addSocialSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const links = await addSocialLink(req.user!.id, parsed.data.platform, parsed.data.url)
    return reply.code(201).send({ success: true, data: links })
  })

  // PATCH /api/users/me/social-links/:id/visibility — hide / un-hide
  app.patch('/users/me/social-links/:id/visibility', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ hidden: z.boolean() }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    const links = await setSocialLinkHidden(req.user!.id, id, parsed.data.hidden)
    return reply.send({ success: true, data: links })
  })

  // DELETE /api/users/me/social-links/:id — unverified links only
  app.delete('/users/me/social-links/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const links = await deleteSocialLink(req.user!.id, id)
    return reply.send({ success: true, data: links })
  })

  // PATCH /api/users/me/social-profile — toggle public visibility
  app.patch('/users/me/social-profile', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z.object({ public: z.boolean() }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    await setSocialPublic(req.user!.id, parsed.data.public)
    return reply.send({ success: true })
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
            fullName: true,
            avatarUrl: true,
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
            merchant: { select: { id: true, status: true, businessName: true } },
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
