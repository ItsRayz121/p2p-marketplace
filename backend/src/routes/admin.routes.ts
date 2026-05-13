import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'
import { sendKycEmail, sendWithdrawalEmail, sendAdminAlertEmail } from '../services/email.service'
import { queues } from '../queues/definitions'

const adminOrSuper = requireRole('admin', 'super_admin')
const adminOrSuperOrKyc = requireRole('admin', 'super_admin', 'kyc_reviewer')
const superAdminOnly = requireRole('super_admin')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paginationParams(query: Record<string, string>) {
  const page = query.page ? parseInt(query.page, 10) : 1
  const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
  const skip = (page - 1) * limit
  return { page, limit, skip }
}

async function createAuditLog(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: { actorId: adminId, action, targetType, targetId, metadata: details as any },
  })
}

// ─── Route Export ─────────────────────────────────────────────────────────────

export async function adminRoutes(app: FastifyInstance) {
  // ── Dashboard Stats ────────────────────────────────────────────────────────

  app.get(
    '/admin/dashboard/stats',
    { preHandler: [authenticate, adminOrSuperOrKyc] },
    async (_req, reply) => {
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const [
        pendingKyc,
        openDisputes,
        pendingWithdrawals,
        pendingInstantBuy,
        todayRevenueResult,
      ] = await Promise.all([
        db.kycSubmission.count({ where: { status: 'pending' } }),
        db.dispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.withdrawal.count({ where: { status: { in: ['pending', 'first_approved'] } } }),
        db.instantBuyOrder.count({ where: { status: 'admin_review' } }),
        db.trade.aggregate({
          where: { status: 'crypto_released', updatedAt: { gte: today } },
          _sum: { fiatAmount: true },
        }),
      ])

      return reply.send({
        success: true,
        data: {
          pendingKyc,
          openDisputes,
          pendingWithdrawals,
          pendingInstantBuy,
          todayRevenue: todayRevenueResult._sum.fiatAmount ?? 0,
        },
      })
    },
  )

  // ── Users ──────────────────────────────────────────────────────────────────

  app.get('/admin/users', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { fullName: { contains: query.search, mode: 'insensitive' } },
      ]
    }
    if (query.role) where.role = query.role
    if (query.kycStatus) where.kycStatus = query.kycStatus

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          role: true,
          kycStatus: true,
          kycLevel: true,
          isBanned: true,
          isSuspended: true,
          createdAt: true,
          tradeStats: { select: { totalTrades: true, completedTrades: true, totalVolumePKR: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.user.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/users/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await db.user.findUnique({
      where: { id },
      include: {
        tradeStats: true,
        trades: { take: 10, orderBy: { createdAt: 'desc' }, select: { id: true, orderRef: true, coin: true, amount: true, fiatAmount: true, status: true, createdAt: true } },
        kycSubmissions: { orderBy: { createdAt: 'desc' } },
        merchant: true,
        wallets: true,
        fraudFlags: { where: { status: 'open' } },
      },
    })
    if (!user) throw Errors.NOT_FOUND('User')
    return reply.send({ success: true, data: user })
  })

  app.post('/admin/users/:id/ban', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const user = await db.user.findUnique({ where: { id }, select: { email: true } })
    if (!user) throw Errors.NOT_FOUND('User')

    await db.user.update({ where: { id }, data: { isBanned: true, suspendReason: parsed.data.reason } })
    await createAuditLog(req.user!.id, 'USER_BANNED', 'User', id, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  app.post('/admin/users/:id/suspend', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500), until: z.string().datetime().optional() })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.user.update({ where: { id }, data: { isSuspended: true, suspendReason: parsed.data.reason } })
    await createAuditLog(req.user!.id, 'USER_SUSPENDED', 'User', id, { reason: parsed.data.reason, until: parsed.data.until })

    return reply.send({ success: true })
  })

  app.post('/admin/users/:id/seize-collateral', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.$transaction(async (tx) => {
      const collateralLocks = await tx.collateralLock.findMany({
        where: { userId: id, status: 'locked' },
      })
      if (collateralLocks.length === 0) {
        throw new AppError('NO_COLLATERAL', 'No active collateral locks found for this user', 404)
      }

      for (const lock of collateralLocks) {
        await tx.collateralLock.update({
          where: { id: lock.id },
          data: { status: 'seized', seizedAt: new Date(), seizeReason: parsed.data.reason },
        })
        // Clear locked balance from USDT wallet
        await tx.wallet.updateMany({
          where: { userId: id, coin: lock.coin },
          data: { lockedBalance: { decrement: lock.amount } },
        })
      }
    })

    await createAuditLog(req.user!.id, 'COLLATERAL_SEIZED', 'User', id, { reason: parsed.data.reason })
    return reply.send({ success: true })
  })

  // ── KYC ───────────────────────────────────────────────────────────────────

  app.get('/admin/kyc/queue', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const [submissions, total] = await Promise.all([
      db.kycSubmission.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, username: true, fullName: true } },
        },
      }),
      db.kycSubmission.count({ where: { status: 'pending' } }),
    ])

    return reply.send({
      success: true,
      data: { submissions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/kyc/:id', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, username: true, fullName: true, kycStatus: true, kycLevel: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')
    return reply.send({ success: true, data: submission })
  })

  app.post('/admin/kyc/:id/approve', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')
    if (submission.status !== 'pending') {
      throw new AppError('INVALID_STATUS', 'Submission is not pending', 400)
    }

    const kycLevel = submission.tier === 'enhanced' ? 'enhanced' : 'basic'

    await db.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'approved', reviewedAt: new Date(), reviewedBy: req.user!.id },
      })
      await tx.user.update({
        where: { id: submission.userId },
        data: { kycStatus: 'approved', kycLevel },
      })
    })

    await createAuditLog(req.user!.id, 'KYC_APPROVED', 'KycSubmission', id, { userId: submission.userId, level: kycLevel })
    await sendKycEmail('approved', submission.user.email, { level: kycLevel })

    return reply.send({ success: true })
  })

  app.post('/admin/kyc/:id/reject', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')

    await db.kycSubmission.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason, reviewedAt: new Date(), reviewedBy: req.user!.id },
    })
    await db.user.update({
      where: { id: submission.userId },
      data: { kycStatus: 'rejected' },
    })

    await createAuditLog(req.user!.id, 'KYC_REJECTED', 'KycSubmission', id, { reason: parsed.data.reason })
    await sendKycEmail('rejected', submission.user.email, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Merchant KYC ───────────────────────────────────────────────────────────

  app.get('/admin/merchants/queue', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const [submissions, total] = await Promise.all([
      db.merchantKycSubmission.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      db.merchantKycSubmission.count({ where: { status: 'pending' } }),
    ])

    return reply.send({
      success: true,
      data: { submissions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/merchants/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const submission = await db.merchantKycSubmission.findUnique({ where: { id } })
    if (!submission) throw Errors.NOT_FOUND('Merchant KYC submission')

    const user = await db.user.findUnique({ where: { id: submission.userId }, select: { email: true } })
    if (!user) throw Errors.NOT_FOUND('User')

    await db.merchantKycSubmission.update({
      where: { id },
      data: { status: 'approved', reviewedAt: new Date(), reviewedBy: req.user!.id },
    })
    await db.merchant.upsert({
      where: { userId: submission.userId },
      create: {
        userId: submission.userId,
        businessName: submission.businessName,
        status: 'approved',
        approvedAt: new Date(),
      },
      update: {
        businessName: submission.businessName,
        status: 'approved',
        approvedAt: new Date(),
      },
    })

    await createAuditLog(req.user!.id, 'MERCHANT_KYC_APPROVED', 'MerchantKycSubmission', id, { userId: submission.userId })
    await sendKycEmail('merchant_approved', user.email)

    return reply.send({ success: true })
  })

  app.post('/admin/merchants/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const submission = await db.merchantKycSubmission.findUnique({ where: { id } })
    if (!submission) throw Errors.NOT_FOUND('Merchant KYC submission')

    const user = await db.user.findUnique({ where: { id: submission.userId }, select: { email: true } })

    await db.merchantKycSubmission.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason, reviewedAt: new Date(), reviewedBy: req.user!.id },
    })

    await createAuditLog(req.user!.id, 'MERCHANT_KYC_REJECTED', 'MerchantKycSubmission', id, { reason: parsed.data.reason })
    if (user) await sendKycEmail('merchant_rejected', user.email, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Trades ─────────────────────────────────────────────────────────────────

  app.get('/admin/trades', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status
    if (query.search) {
      where.OR = [
        { orderRef: { contains: query.search, mode: 'insensitive' } },
        { coin: { contains: query.search, mode: 'insensitive' } },
      ]
    }

    const [trades, total] = await Promise.all([
      db.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          buyer: { select: { username: true, email: true } },
          seller: { select: { username: true, email: true } },
          dispute: { select: { id: true, status: true } },
        },
      }),
      db.trade.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { trades, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/trades/:id/confirm-payment', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const trade = await db.trade.findUnique({ where: { id } })
    if (!trade) throw Errors.NOT_FOUND('Trade')

    await db.trade.update({
      where: { id },
      data: { status: 'payment_confirmed' },
    })
    await createAuditLog(req.user!.id, 'TRADE_PAYMENT_CONFIRMED_ADMIN', 'Trade', id, {})

    return reply.send({ success: true })
  })

  app.post('/admin/trades/:id/cancel', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.trade.update({
      where: { id },
      data: { status: 'cancelled', cancelReason: parsed.data.reason, cancelledBy: req.user!.id, cancelledAt: new Date() },
    })
    await createAuditLog(req.user!.id, 'TRADE_CANCELLED_ADMIN', 'Trade', id, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Disputes ───────────────────────────────────────────────────────────────

  app.get('/admin/disputes', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status

    const [disputes, total] = await Promise.all([
      db.dispute.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          trade: {
            include: {
              buyer: { select: { username: true, email: true } },
              seller: { select: { username: true, email: true } },
            },
          },
          _count: { select: { messages: true } },
        },
      }),
      db.dispute.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { disputes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/disputes/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const dispute = await db.dispute.findUnique({
      where: { id },
      include: {
        trade: {
          include: {
            buyer: { select: { id: true, username: true, email: true } },
            seller: { select: { id: true, username: true, email: true } },
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')
    return reply.send({ success: true, data: dispute })
  })

  app.post('/admin/disputes/:id/resolve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      winner: z.enum(['buyer', 'seller']),
      resolution: z.string().min(1).max(2000),
      resolutionNote: z.string().max(2000).optional(),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const dispute = await db.dispute.findUnique({
      where: { id },
      include: {
        trade: {
          include: {
            buyer: { select: { email: true } },
            seller: { select: { email: true } },
          },
        },
      },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')
    if (dispute.status === 'resolved') {
      throw new AppError('ALREADY_RESOLVED', 'Dispute is already resolved', 400)
    }

    await db.$transaction(async (tx) => {
      await tx.dispute.update({
        where: { id },
        data: {
          status: 'resolved',
          winner: parsed.data.winner,
          resolution: parsed.data.resolution,
          resolvedAt: new Date(),
          resolvedBy: req.user!.id,
        },
      })
    })

    await createAuditLog(req.user!.id, 'DISPUTE_RESOLVED', 'Dispute', id, {
      winner: parsed.data.winner,
      resolution: parsed.data.resolution,
    })

    await Promise.allSettled([
      // Simple notification emails — reuse admin alert as fallback
      sendAdminAlertEmail(
        `Dispute ${id} resolved`,
        `Trade: ${dispute.trade.orderRef}\nWinner: ${parsed.data.winner}\nResolution: ${parsed.data.resolution}`,
      ),
    ])

    return reply.send({ success: true })
  })

  // ── Instant Buy ────────────────────────────────────────────────────────────

  app.get('/admin/instant-buy', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status

    const [orders, total] = await Promise.all([
      db.instantBuyOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { username: true, email: true } },
        },
      }),
      db.instantBuyOrder.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/instant-buy/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.instantBuyOrder.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true, email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Instant buy order')
    return reply.send({ success: true, data: order })
  })

  app.post('/admin/instant-buy/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ txHash: z.string().min(1) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.instantBuyOrder.update({
      where: { id },
      data: { status: 'completed', verificationStatus: 'layer2_approved', incomingTxHash: parsed.data.txHash },
    })
    await createAuditLog(req.user!.id, 'INSTANT_BUY_APPROVED', 'InstantBuyOrder', id, { txHash: parsed.data.txHash })

    return reply.send({ success: true })
  })

  app.post('/admin/instant-buy/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const order = await db.instantBuyOrder.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Order')

    await db.instantBuyOrder.update({
      where: { id },
      data: { status: 'rejected', verificationStatus: 'layer2_rejected', rejectionReason: parsed.data.reason },
    })
    await createAuditLog(req.user!.id, 'INSTANT_BUY_REJECTED', 'InstantBuyOrder', id, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Withdrawals ────────────────────────────────────────────────────────────

  app.get('/admin/withdrawals', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status

    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.withdrawal.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { withdrawals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/withdrawals/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = req.user!.id

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (!['pending', 'first_approved'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Withdrawal is in status ${withdrawal.status}`, 400)
    }

    // Two-person approval
    if (!withdrawal.firstApprovedBy) {
      // First approval
      await db.withdrawal.update({
        where: { id },
        data: { status: 'first_approved', firstApprovedBy: adminId },
      })
      await createAuditLog(adminId, 'WITHDRAWAL_FIRST_APPROVED', 'Withdrawal', id, {})
      return reply.send({ success: true, message: 'First approval recorded. Requires second admin approval.' })
    } else {
      // Second approval — must be different admin
      if (withdrawal.firstApprovedBy === adminId) {
        throw new AppError('SAME_ADMIN', 'A different admin must provide the second approval', 403)
      }
      await db.withdrawal.update({
        where: { id },
        data: { status: 'approved', secondApprovedBy: adminId },
      })
      await createAuditLog(adminId, 'WITHDRAWAL_SECOND_APPROVED', 'Withdrawal', id, {})
      return reply.send({ success: true, message: 'Withdrawal fully approved.' })
    }
  })

  app.post('/admin/withdrawals/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (withdrawal.status === 'completed' || withdrawal.status === 'sent') {
      throw new AppError('INVALID_STATUS', 'Cannot reject a completed or sent withdrawal', 400)
    }

    await db.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id },
        data: { status: 'rejected', rejectedBy: req.user!.id, rejectionReason: parsed.data.reason },
      })
      // Refund amount + fee to wallet
      await tx.wallet.updateMany({
        where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
        data: { balance: { increment: Number(withdrawal.amount) + Number(withdrawal.fee) } },
      })
    })

    await createAuditLog(req.user!.id, 'WITHDRAWAL_REJECTED', 'Withdrawal', id, { reason: parsed.data.reason })
    await sendWithdrawalEmail('rejected', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      reason: parsed.data.reason,
    })

    return reply.send({ success: true })
  })

  // ── Config ─────────────────────────────────────────────────────────────────

  app.get('/admin/config', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const config = await db.platformConfig.findMany({ orderBy: { key: 'asc' } })
    return reply.send({ success: true, data: config })
  })

  app.patch('/admin/config', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const bodySchema = z.object({ key: z.string().min(1), value: z.string() })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const updated = await db.platformConfig.upsert({
      where: { key: parsed.data.key },
      create: { key: parsed.data.key, value: parsed.data.value },
      update: { value: parsed.data.value },
    })
    await createAuditLog(req.user!.id, 'CONFIG_UPDATED', 'PlatformConfig', updated.id, { key: parsed.data.key, value: parsed.data.value })

    return reply.send({ success: true, data: updated })
  })

  // ── Analytics ──────────────────────────────────────────────────────────────

  app.get('/admin/analytics', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const period = (query.period as '7d' | '30d' | '90d') ?? '7d'
    const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
    const days = daysMap[period]
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const [badgeDistribution, topTraders, newUsers, completedTrades] = await Promise.all([
      db.tradeStats.groupBy({
        by: ['badge'],
        _count: { badge: true },
      }),
      db.tradeStats.findMany({
        orderBy: { totalVolumePKR: 'desc' },
        take: 10,
        include: { user: { select: { username: true } } },
      }),
      db.user.count({ where: { createdAt: { gte: since } } }),
      db.trade.count({ where: { status: 'crypto_released', updatedAt: { gte: since } } }),
    ])

    return reply.send({
      success: true,
      data: {
        period,
        since,
        newUsers,
        completedTrades,
        badgeDistribution: badgeDistribution.map((b) => ({ badge: b.badge, count: b._count.badge })),
        topTraders: topTraders.map((t) => ({
          userId: t.userId,
          username: t.user.username,
          totalVolumePKR: t.totalVolumePKR,
          completedTrades: t.completedTrades,
          badge: t.badge,
        })),
      },
    })
  })

  // ── Wallet Addresses ───────────────────────────────────────────────────────

  app.get('/admin/wallet/addresses', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const addresses = await db.platformConfig.findMany({
      where: { key: { startsWith: 'deposit_address_' } },
    })
    return reply.send({ success: true, data: addresses })
  })

  app.post('/admin/wallet/addresses', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const bodySchema = z.object({
      coin: z.string().min(1).max(20),
      network: z.string().min(1).max(50),
      address: z.string().min(1),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const key = `deposit_address_${parsed.data.coin.toLowerCase()}_${parsed.data.network.toLowerCase()}`
    const config = await db.platformConfig.upsert({
      where: { key },
      create: { key, value: parsed.data.address },
      update: { value: parsed.data.address },
    })
    await createAuditLog(req.user!.id, 'WALLET_ADDRESS_UPDATED', 'PlatformConfig', config.id, {
      coin: parsed.data.coin,
      network: parsed.data.network,
      address: parsed.data.address,
    })

    return reply.send({ success: true, data: config })
  })

  app.get('/admin/wallet/pending-payouts', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where: { status: 'approved' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.withdrawal.count({ where: { status: 'approved' } }),
    ])

    return reply.send({
      success: true,
      data: { withdrawals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // ── Audit Log ──────────────────────────────────────────────────────────────

  app.get('/admin/audit-log', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.adminId) where.actorId = query.adminId
    if (query.targetType) where.targetType = query.targetType

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          actor: { select: { username: true, email: true } },
        },
      }),
      db.auditLog.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // ── Gas Fee Admin ──────────────────────────────────────────────────────────

  app.get('/admin/gas/orders', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status

    const [orders, total] = await Promise.all([
      db.gasFeeOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.gasFeeOrder.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/gas/orders/:id/retry', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    if (!['failed', 'payment_detected'].includes(order.status)) {
      throw new AppError('INVALID_STATUS', 'Order cannot be retried in its current status', 400)
    }

    await db.gasFeeOrder.update({ where: { id }, data: { status: 'payment_detected', failureReason: null } })
    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_ORDER_RETRY', 'GasFeeOrder', id, {})

    return reply.send({ success: true })
  })

  app.post('/admin/gas/orders/:id/refund', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    await db.gasFeeOrder.update({
      where: { id },
      data: { status: 'refunded', refundedAt: new Date() },
    })
    await createAuditLog(req.user!.id, 'GAS_ORDER_REFUNDED', 'GasFeeOrder', id, {})

    return reply.send({ success: true })
  })
}
