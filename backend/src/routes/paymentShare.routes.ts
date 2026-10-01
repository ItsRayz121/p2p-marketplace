import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../lib/prisma'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { recordAuditLog } from '../lib/audit'
import { generatePaymentSlug, isValidPaymentSlug, isValidPaymentUsername, toPublicPaymentMethod, toPublicPaymentAddress } from '../lib/paymentShare'

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  methodIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  addressIds: z.array(z.string().min(1).max(64)).max(100).optional(),
}).refine((v) => v.enabled !== undefined || v.methodIds !== undefined || v.addressIds !== undefined, { message: 'Nothing to update' })

/**
 * Shareable payment page. Private by default: a payment method or saved address is public
 * only when its owner has (a) enabled their payment page and (b) flagged that item as shared,
 * and the item is still active and not hidden. Reachable at /pay/<username> or /pay/<random slug>.
 */
export async function paymentShareRoutes(app: FastifyInstance) {
  // GET /users/me/payment-share — current state for the owner's settings dialog.
  app.get('/users/me/payment-share', { preHandler: [authenticate] }, async (req, reply) => {
    const [profile, user] = await Promise.all([
      db.paymentShareProfile.findUnique({ where: { userId: req.user!.id }, select: { slug: true, enabled: true } }),
      db.user.findUnique({ where: { id: req.user!.id }, select: { username: true } }),
    ])
    return reply.send({ success: true, data: { enabled: profile?.enabled ?? false, slug: profile?.slug ?? null, username: user?.username ?? null } })
  })

  // PUT /users/me/payment-share — enable/disable the page and choose shared methods.
  app.put('/users/me/payment-share', { preHandler: [authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { enabled, methodIds, addressIds } = parsed.data

    const result = await db.$transaction(async (tx) => {
      const existing = await tx.paymentShareProfile.findUnique({ where: { userId } })

      if (methodIds) {
        // Only the caller's own active, non-hidden methods can ever be shared — ids are
        // intersected with the owner's rows, never trusted as-is.
        const owned = await tx.paymentMethod.findMany({
          where: { userId, isActive: true, hidden: false, id: { in: methodIds } },
          select: { id: true },
        })
        const ownedIds = owned.map((m) => m.id)
        await tx.paymentMethod.updateMany({ where: { userId, isActive: true, id: { notIn: ownedIds }, shared: true }, data: { shared: false } })
        if (ownedIds.length) await tx.paymentMethod.updateMany({ where: { userId, id: { in: ownedIds } }, data: { shared: true } })
      }

      if (addressIds) {
        const owned = await tx.savedAddress.findMany({ where: { userId, hidden: false, id: { in: addressIds } }, select: { id: true } })
        const ownedIds = owned.map((a) => a.id)
        await tx.savedAddress.updateMany({ where: { userId, id: { notIn: ownedIds }, shared: true }, data: { shared: false } })
        if (ownedIds.length) await tx.savedAddress.updateMany({ where: { userId, id: { in: ownedIds } }, data: { shared: true } })
      }

      const nextEnabled = enabled ?? existing?.enabled ?? false
      if (nextEnabled) {
        const [methodCount, addressCount] = await Promise.all([
          tx.paymentMethod.count({ where: { userId, isActive: true, hidden: false, shared: true } }),
          tx.savedAddress.count({ where: { userId, hidden: false, shared: true } }),
        ])
        if (methodCount + addressCount === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one item to share.', 400)
      }

      // upsert (not find-then-create) so two concurrent first-time saves can't hit the userId unique constraint.
      const profile = await tx.paymentShareProfile.upsert({
        where: { userId },
        update: { enabled: nextEnabled },
        create: { userId, slug: generatePaymentSlug(), enabled: nextEnabled },
        select: { slug: true, enabled: true },
      })
      return { profile, wasEnabled: existing?.enabled ?? false }
    })

    void recordAuditLog(userId, result.profile.enabled ? 'PAYMENT_PAGE_ENABLED' : 'PAYMENT_PAGE_DISABLED', 'PaymentShareProfile', userId, {
      wasEnabled: result.wasEnabled, methodCount: methodIds?.length ?? null, addressCount: addressIds?.length ?? null,
    })
    return reply.send({ success: true, data: { enabled: result.profile.enabled, slug: result.profile.slug } })
  })

  // POST /users/me/payment-share/regenerate — new slug; the old link stops working at once.
  app.post('/users/me/payment-share/regenerate', { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const userId = req.user!.id
    const existing = await db.paymentShareProfile.findUnique({ where: { userId }, select: { id: true } })
    if (!existing) throw new AppError('NOT_FOUND', 'Payment page not set up yet', 404)
    const profile = await db.paymentShareProfile.update({ where: { userId }, data: { slug: generatePaymentSlug() }, select: { slug: true, enabled: true } })
    void recordAuditLog(userId, 'PAYMENT_PAGE_LINK_REGENERATED', 'PaymentShareProfile', userId, {})
    return reply.send({ success: true, data: { enabled: profile.enabled, slug: profile.slug } })
  })

  // GET /public/pay/:slug — unauthenticated, read-only, minimal DTO. `slug` is the random
  // slug or the owner's username. A missing, malformed or disabled link all return the same
  // 404 so links cannot be probed.
  app.get('/public/pay/:slug', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const bySlug = isValidPaymentSlug(slug)
    if (!bySlug && !isValidPaymentUsername(slug)) throw new AppError('NOT_FOUND', 'This payment link is unavailable.', 404)

    const userSelect = {
      fullName: true, username: true, avatarUrl: true, isBanned: true, isSuspended: true,
      paymentMethods: {
        where: { isActive: true, hidden: false, shared: true },
        orderBy: { createdAt: 'desc' as const },
        select: { type: true, accountName: true, mobileNumber: true, bankName: true, ibanNumber: true, accountNumber: true },
      },
      savedAddresses: {
        where: { hidden: false, shared: true },
        orderBy: { coin: 'asc' as const },
        select: { coin: true, network: true, address: true, label: true },
      },
    }

    // Random slug first; otherwise treat it as a username (case-insensitive).
    let profile = bySlug
      ? await db.paymentShareProfile.findUnique({ where: { slug }, select: { enabled: true, user: { select: userSelect } } })
      : null
    if (!profile && isValidPaymentUsername(slug)) {
      profile = await db.paymentShareProfile.findFirst({
        where: { user: { username: { equals: slug, mode: 'insensitive' } } },
        select: { enabled: true, user: { select: userSelect } },
      })
    }
    if (!profile || !profile.enabled || profile.user.isBanned || profile.user.isSuspended) {
      throw new AppError('NOT_FOUND', 'This payment link is unavailable.', 404)
    }

    const methods = profile.user.paymentMethods.map(toPublicPaymentMethod).filter((m) => m.numbers.length > 0)
    const addresses = profile.user.savedAddresses.map(toPublicPaymentAddress).filter((a) => a.address)
    // Never cache: disabling the page or hiding an item must take effect immediately.
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    return reply.send({
      success: true,
      data: { displayName: profile.user.fullName || profile.user.username, avatarUrl: profile.user.avatarUrl ?? null, methods, addresses },
    })
  })
}
