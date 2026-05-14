import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'
import { sendKycEmail, sendWithdrawalEmail, sendAdminAlertEmail } from '../services/email.service'
import { queues } from '../queues/definitions'
import { logger as log } from '../lib/logger'
import { getStreamStatusSummary, ensureSubscriptionRows, enqueuePendingSubscriptions } from '../services/moralisStreams.service'
import { getChainById } from '../lib/chains'
import { processDepositEvent, creditDetectedDeposit } from '../services/depositWatcher.service'
import { refreshDepositFromRpc } from '../services/depositReconcile.service'
import { getRpcUrl } from '../lib/chains'
import { getTransactionByHash, getTransactionReceipt, getBlockNumber } from '../lib/evmRpc'
import { Prisma } from '@prisma/client'
type JsonValue = Prisma.InputJsonValue

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { actorId: adminId, action, targetType, targetId, metadata: details as any },
  })
}

function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  db.notification.create({ data: { userId, type, title, body, metadata: metadata as JsonValue } }).catch(() => {})
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

  app.post('/admin/users/:id/ban', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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

  app.post('/admin/users/:id/unban', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = await db.user.findUnique({ where: { id }, select: { email: true } })
    if (!user) throw Errors.NOT_FOUND('User')
    await db.user.update({ where: { id }, data: { isBanned: false, isSuspended: false, suspendReason: null } })
    await createAuditLog(req.user!.id, 'USER_UNBANNED', 'User', id, {})
    return reply.send({ success: true })
  })

  app.post('/admin/users/:id/suspend', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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

  app.post('/admin/kyc/:id/approve', { preHandler: [authenticate, adminOrSuperOrKyc], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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
    notify(submission.userId, 'kyc', 'KYC Approved', 'Your identity has been verified. You now have full platform access.', { tier: kycLevel })

    return reply.send({ success: true })
  })

  app.post('/admin/kyc/:id/reject', { preHandler: [authenticate, adminOrSuperOrKyc], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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
    notify(submission.userId, 'kyc', 'KYC Rejected', `Your KYC submission was rejected. Reason: ${parsed.data.reason}`, { rejectionReason: parsed.data.reason })

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

  app.post('/admin/merchants/:id/approve', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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

  app.post('/admin/merchants/:id/reject', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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

  app.post('/admin/disputes/:id/resolve', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
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

  // GET /admin/moralis-streams/status — per-chain stream config + counts +
  // reachability check. Lets ops see at a glance which chains are wired up,
  // how many addresses are subscribed/pending/failed, and whether the
  // Moralis API answered on the latest probe.
  app.get('/admin/moralis-streams/status', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const summary = await getStreamStatusSummary()
    return reply.send({ success: true, data: summary })
  })

  // GET /admin/moralis-streams/subscriptions — paginated subscription rows.
  // Useful for inspecting "what's stuck in failed".
  app.get('/admin/moralis-streams/subscriptions', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)
    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status
    if (query.chain) where.chain = query.chain
    const [subscriptions, total] = await Promise.all([
      db.moralisStreamSubscription.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.moralisStreamSubscription.count({ where }),
    ])
    return reply.send({
      success: true,
      data: { subscriptions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // POST /admin/moralis-streams/backfill — walk all existing DepositAddress
  // rows, create any missing MoralisStreamSubscription rows, and enqueue
  // subscribe jobs for everything that's pending. Idempotent. Returns 202
  // immediately and runs in the background — operator polls /status to watch
  // it complete. Safe to call repeatedly (e.g. after adding a new chain).
  app.post('/admin/moralis-streams/backfill', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const adminId = req.user!.id
    const total = await db.depositAddress.count({ where: { chainFamily: 'EVM' } })
    const runId = randomUUID()

    log.info({ runId, adminId, totalRows: total }, 'Moralis backfill started via admin endpoint')

    // Fire-and-forget. We don't await — operator gets an immediate 202 with
    // the row count to expect, and the work proceeds asynchronously while
    // /admin/moralis-streams/status reflects progress in real time. Errors
    // on individual rows are logged and counted but never abort the loop —
    // a single problematic address must not block the rest of the backfill.
    ;(async () => {
      const batchSize = 100
      let cursor: string | undefined
      let scanned = 0
      let perAddressErrors = 0
      let enqueuedJobs = 0
      const startedAt = Date.now()
      try {
        for (;;) {
          const batch = await db.depositAddress.findMany({
            where: { chainFamily: 'EVM' },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: { id: true },
          })
          if (batch.length === 0) break
          for (const da of batch) {
            try {
              await ensureSubscriptionRows(da.id)
              const pending = await db.moralisStreamSubscription.count({
                where: { depositAddressId: da.id, status: 'pending' },
              })
              await enqueuePendingSubscriptions(da.id)
              enqueuedJobs += pending
              scanned += 1
            } catch (rowErr) {
              perAddressErrors += 1
              log.error(
                { runId, depositAddressId: da.id, err: rowErr instanceof Error ? rowErr.message : 'unknown' },
                'Backfill failed for one address — continuing',
              )
            }
          }
          cursor = batch[batch.length - 1]!.id
          log.info({ runId, scanned, total, enqueuedJobs, perAddressErrors }, 'Backfill batch complete')
        }
      } catch (err) {
        log.error({ runId, err: err instanceof Error ? err.message : 'unknown' }, 'Moralis backfill aborted')
      }
      log.info(
        { runId, scanned, total, enqueuedJobs, perAddressErrors, elapsedMs: Date.now() - startedAt },
        'Moralis backfill complete',
      )
    })()

    void createAuditLog(adminId, 'MORALIS_STREAMS_BACKFILL_STARTED', 'MoralisStreamSubscription', 'all', { total, runId })
    return reply.code(202).send({
      success: true,
      data: {
        runId,
        startedFor: total,
        message: 'Backfill running in background. Poll /admin/moralis-streams/status to watch progress.',
      },
    })
  })

  // GET /admin/moralis-streams/debug — single consolidated payload for ops.
  // Returns everything the operator wants to glance at on one screen:
  //   - per-chain status + counts
  //   - sample of pending and failed subscriptions
  //   - last 25 deposits (any status) with user info
  //   - last 25 credited deposits
  //   - last 25 webhook events that hit `Deposit` rows
  //   - audit-log entries for MORALIS_* and DEPOSIT_* actions
  // No secrets or full payloads are included. Safe to give super_admin access.
  app.get('/admin/moralis-streams/debug', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const [status, pendingSubs, failedSubs, recentDeposits, recentCredited, recentAuditLogs] = await Promise.all([
      getStreamStatusSummary(),
      db.moralisStreamSubscription.findMany({
        where: { status: 'pending' },
        take: 25,
        orderBy: { updatedAt: 'desc' },
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.moralisStreamSubscription.findMany({
        where: { status: 'failed' },
        take: 25,
        orderBy: { updatedAt: 'desc' },
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.deposit.findMany({
        take: 25,
        orderBy: { detectedAt: 'desc' },
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.deposit.findMany({
        where: { status: 'credited' },
        take: 25,
        orderBy: { creditedAt: 'desc' },
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.auditLog.findMany({
        where: {
          OR: [
            { action: { startsWith: 'MORALIS_' } },
            { action: { startsWith: 'DEPOSIT_' } },
            { action: { startsWith: 'WITHDRAWAL_' } },
          ],
        },
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, username: true, email: true } } },
      }),
    ])

    return reply.send({
      success: true,
      data: {
        status,
        subscriptions: {
          pending: pendingSubs,
          failed: failedSubs,
        },
        deposits: {
          recent: recentDeposits,
          credited: recentCredited,
        },
        auditLogs: recentAuditLogs,
      },
    })
  })

  // POST /admin/moralis-streams/retry/:id — re-enqueue a single failed sub.
  app.post('/admin/moralis-streams/retry/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const sub = await db.moralisStreamSubscription.findUnique({ where: { id } })
    if (!sub) throw Errors.NOT_FOUND('Subscription')
    await db.moralisStreamSubscription.update({
      where: { id },
      data: { status: 'pending', lastError: null },
    })
    await queues.moralisSubscribe.add('subscribe', { subscriptionId: id }, { jobId: 'moralis-sub-retry-' + id + '-' + Date.now() })
    void createAuditLog(req.user!.id, 'MORALIS_SUBSCRIPTION_RETRIED', 'MoralisStreamSubscription', id, {})
    return reply.send({ success: true })
  })

  // POST /admin/moralis-streams/retry-all-failed — bulk retry every failed
  // subscription. Useful after a Moralis-side outage where many rows ended
  // up in `failed` due to fatal API codes (e.g. a stream id was wrong then
  // corrected). Each row is flipped back to `pending` and re-enqueued.
  app.post('/admin/moralis-streams/retry-all-failed', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const failedRows = await db.moralisStreamSubscription.findMany({
      where: { status: 'failed' },
      select: { id: true },
    })
    if (failedRows.length === 0) {
      return reply.send({ success: true, data: { retried: 0 } })
    }
    await db.moralisStreamSubscription.updateMany({
      where: { id: { in: failedRows.map((r) => r.id) } },
      data: { status: 'pending', lastError: null },
    })
    await Promise.all(
      failedRows.map((r) =>
        queues.moralisSubscribe
          .add('subscribe', { subscriptionId: r.id }, { jobId: 'moralis-sub-retry-' + r.id + '-' + Date.now() })
          .catch((err) => log.warn({ err, id: r.id }, 'Bulk retry enqueue failed')),
      ),
    )
    void createAuditLog(req.user!.id, 'MORALIS_SUBSCRIPTIONS_BULK_RETRIED', 'MoralisStreamSubscription', 'all', {
      count: failedRows.length,
    })
    return reply.send({ success: true, data: { retried: failedRows.length } })
  })

  // POST /admin/deposits/rescan — manual reconciliation. The operator pastes
  // a txHash + chain + asset + amount and we feed it through the same
  // processDepositEvent pipeline a real webhook would. Use this when a
  // Moralis webhook was missed (outage, dropped delivery, stream not
  // subscribed at the time) and a user is waiting on credit they actually
  // sent. The watcher's idempotency (unique txHash+chain+asset) makes this
  // safe to call multiple times — a previously-credited tx is a no-op.
  app.post('/admin/deposits/rescan', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'txHash must be 0x + 64 hex chars'),
      chain: z.string().min(1),
      asset: z.string().min(1), // '0x...' contract address or 'native'
      symbol: z.string().optional(),
      fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'fromAddress must be 0x + 40 hex chars'),
      toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'toAddress must be 0x + 40 hex chars'),
      rawAmount: z.string().regex(/^\d+$/, 'rawAmount must be a decimal integer string (raw on-chain units)'),
      confirmations: z.number().int().nonnegative(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { txHash, chain, asset, symbol, fromAddress, toAddress, rawAmount, confirmations } = parsed.data

    const chainCfg = getChainById(chain)
    if (!chainCfg || chainCfg.chainId == null) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${chain} is not supported`, 400)
    }

    const result = await processDepositEvent({
      chainId: chainCfg.chainId,
      txHash,
      fromAddress,
      toAddress,
      asset,
      symbol: symbol ?? '',
      amount: rawAmount,
      confirmations,
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_RESCAN_TRIGGERED', 'Deposit', txHash, {
      chain, asset, rawAmount, confirmations, result,
    })
    return reply.send({ success: true, data: { result } })
  })

  // POST /admin/deposits/:id/force-credit — admin-driven credit. Now requires
  // either (a) a successful on-chain RPC verification that the tx exists, was
  // not reverted, and was sent to the deposit row's `toAddress`, OR (b) the
  // `skipChainVerification: true` override + a super_admin (NOT admin) actor.
  // Heavily audit-logged either way.
  app.post('/admin/deposits/:id/force-credit', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({
      reason: z.string().min(10).max(500),
      // Last-resort override for cases where the chain RPC is unavailable but
      // the operator has separately verified the tx (e.g. via block explorer).
      // Must be paired with a super_admin actor — adminOrSuper covers that
      // here but we additionally enforce it below.
      skipChainVerification: z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Reason is required (10-500 chars)', 400)

    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')
    if (deposit.status === 'credited') {
      throw new AppError('ALREADY_CREDITED', 'Deposit is already credited', 409)
    }
    if (!deposit.userId) {
      throw new AppError('NO_USER', 'Deposit has no associated user — cannot force-credit', 400)
    }

    const chainCfg = getChainById(deposit.chain)
    if (!chainCfg) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${deposit.chain} not configured`, 400)
    }

    // On-chain verification — required unless the actor opts out.
    let verification:
      | { verified: true; receiptStatus: '0x0' | '0x1'; txBlock: string; currentBlock: string; confirmations: number; onChainTo: string | null }
      | { verified: false; reason: string }
    if (parsed.data.skipChainVerification) {
      if (req.user!.role !== 'super_admin') {
        throw new AppError(
          'SUPER_ADMIN_REQUIRED',
          'Only super_admin may force-credit without on-chain verification',
          403,
        )
      }
      verification = { verified: false, reason: 'skipped_by_super_admin' }
    } else {
      const rpcUrl = getRpcUrl(deposit.chain)
      if (!rpcUrl) {
        throw new AppError('NO_RPC_URL', `No RPC configured for chain ${deposit.chain}`, 503)
      }
      try {
        const [currentBlock, receipt] = await Promise.all([
          getBlockNumber(rpcUrl, deposit.chain),
          getTransactionReceipt(rpcUrl, deposit.chain, deposit.txHash),
        ])
        if (!receipt) {
          throw new AppError(
            'TX_NOT_FOUND',
            'Transaction receipt not found on chain. Tx may be unmined, dropped, or txHash mismatched.',
            400,
          )
        }
        if (receipt.status === '0x0') {
          throw new AppError('TX_REVERTED', 'On-chain transaction reverted (status=0x0). Refusing to credit.', 400)
        }
        // For ERC20 transfers, receipt.to is the token contract — not the
        // recipient. For native transfers, receipt.to is the recipient. We
        // only enforce the to-address check on native transfers.
        if (deposit.asset === 'native' && receipt.to && receipt.to.toLowerCase() !== deposit.toAddress.toLowerCase()) {
          throw new AppError(
            'TX_RECIPIENT_MISMATCH',
            `On-chain recipient ${receipt.to} does not match deposit toAddress ${deposit.toAddress}`,
            400,
          )
        }
        const confirmations = currentBlock >= receipt.blockNumber
          ? Number(currentBlock - receipt.blockNumber + 1n)
          : 0
        verification = {
          verified: true,
          receiptStatus: receipt.status,
          txBlock: receipt.blockNumber.toString(),
          currentBlock: currentBlock.toString(),
          confirmations,
          onChainTo: receipt.to,
        }
      } catch (err) {
        if (err instanceof AppError) throw err
        throw new AppError(
          'RPC_VERIFICATION_FAILED',
          `On-chain verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
          502,
        )
      }
    }

    log.warn(
      {
        depositId: deposit.id,
        adminId: req.user!.id,
        adminRole: req.user!.role,
        txHash: deposit.txHash,
        chain: deposit.chain,
        symbol: deposit.symbol,
        amount: deposit.amount.toString(),
        skipChainVerification: !!parsed.data.skipChainVerification,
        verification,
        reason: parsed.data.reason,
      },
      'Admin force-credit initiated',
    )

    const outcome = await creditDetectedDeposit(deposit.id, {
      source: 'admin-force',
      allowFromRejected: true,
      extraMetadata: {
        forceCredit: true,
        adminId: req.user!.id,
        adminRole: req.user!.role,
        reason: parsed.data.reason,
        verification,
      },
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_FORCE_CREDITED', 'Deposit', deposit.id, {
      reason: parsed.data.reason,
      userId: deposit.userId,
      symbol: deposit.symbol,
      amount: deposit.amount.toString(),
      txHash: deposit.txHash,
      skipChainVerification: !!parsed.data.skipChainVerification,
      verification,
      outcome,
    })

    return reply.send({ success: true, data: { outcome, verification } })
  })

  // POST /admin/deposits/:id/refresh-confirmations — re-fetch the deposit's
  // current on-chain confirmation count via RPC and update the row. If the
  // refreshed count crosses the chain threshold the deposit is credited via
  // the same atomic credit helper used by the webhook and reconciler paths.
  // Safe to call repeatedly. Returns the verification + credit outcome.
  app.post('/admin/deposits/:id/refresh-confirmations', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')

    const refresh = await refreshDepositFromRpc(id)
    log.info({ depositId: id, adminId: req.user!.id, refresh }, 'Admin refresh-confirmations')

    let credit: unknown = null
    if (refresh.ok && refresh.receiptStatus === '0x1' && refresh.after >= refresh.threshold && deposit.status === 'detected') {
      credit = await creditDetectedDeposit(id, {
        source: 'admin-refresh',
        extraMetadata: {
          adminId: req.user!.id,
          refresh: {
            confirmations: refresh.after,
            currentBlock: refresh.currentBlock.toString(),
            txBlock: refresh.txBlock.toString(),
          },
        },
      })
    }

    void createAuditLog(req.user!.id, 'DEPOSIT_REFRESH_CONFIRMATIONS', 'Deposit', id, {
      txHash: deposit.txHash,
      chain: deposit.chain,
      refresh: refresh.ok
        ? {
            ok: true,
            before: refresh.before,
            after: refresh.after,
            threshold: refresh.threshold,
            receiptStatus: refresh.receiptStatus,
            txBlock: refresh.txBlock.toString(),
            currentBlock: refresh.currentBlock.toString(),
          }
        : refresh,
      credit,
    })

    return reply.send({ success: true, data: { refresh, credit } })
  })

  // POST /admin/deposits/reconcile-by-tx — given (txHash, chain), look up the
  // tx on chain via RPC, find or create the Deposit row, and run the standard
  // detection + credit pipeline. Used when:
  //   - Moralis never delivered the unconfirmed webhook (so no Deposit row exists)
  //   - or the user pastes a txHash from their wallet and asks for manual help
  // Idempotent — a previously-credited deposit just returns its status.
  app.post('/admin/deposits/reconcile-by-tx', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'txHash must be 0x + 64 hex chars'),
      chain: z.string().min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const chainCfg = getChainById(parsed.data.chain)
    if (!chainCfg || chainCfg.chainId == null) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${parsed.data.chain} is not supported`, 400)
    }
    const rpcUrl = getRpcUrl(chainCfg.id)
    if (!rpcUrl) {
      throw new AppError('NO_RPC_URL', `No RPC configured for chain ${chainCfg.id}`, 503)
    }

    // Pull tx + receipt from chain.
    const [currentBlock, tx, receipt] = await Promise.all([
      getBlockNumber(rpcUrl, chainCfg.id),
      getTransactionByHash(rpcUrl, chainCfg.id, parsed.data.txHash),
      getTransactionReceipt(rpcUrl, chainCfg.id, parsed.data.txHash),
    ]).catch((err) => {
      throw new AppError('RPC_FAILED', err instanceof Error ? err.message : 'rpc_failed', 502)
    })

    if (!tx) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${parsed.data.txHash} not found on ${chainCfg.id}`, 404)
    }
    if (!receipt) {
      throw new AppError('TX_UNMINED', 'Transaction has not been mined yet — try again once it confirms', 409)
    }
    if (receipt.status === '0x0') {
      throw new AppError('TX_REVERTED', 'On-chain tx reverted (status=0x0) — cannot credit', 400)
    }

    // Only native transfers carry a usable `value` directly on the tx. For
    // ERC20 transfers the operator should use /admin/deposits/rescan or
    // re-trigger the Moralis backfill — we can't safely reconstruct the
    // recipient + token amount from a single eth_getTransactionByHash call.
    if (tx.value === 0n) {
      throw new AppError(
        'ERC20_NOT_SUPPORTED_HERE',
        'Reconcile-by-tx currently supports native-asset transfers only. For ERC20 deposits, use POST /admin/deposits/rescan with the full (txHash, chain, asset, toAddress, fromAddress, rawAmount) payload.',
        400,
      )
    }
    if (!tx.to) {
      throw new AppError('TX_NO_RECIPIENT', 'Transaction has no recipient (contract creation?)', 400)
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0

    log.info(
      {
        adminId: req.user!.id,
        txHash: parsed.data.txHash,
        chain: chainCfg.id,
        from: tx.from,
        to: tx.to,
        valueWei: tx.value.toString(),
        confirmations,
      },
      'Admin reconcile-by-tx via RPC',
    )

    const result = await processDepositEvent({
      chainId: chainCfg.chainId,
      txHash: parsed.data.txHash,
      fromAddress: tx.from,
      toAddress: tx.to,
      asset: 'native',
      symbol: chainCfg.nativeSymbol,
      amount: tx.value.toString(),
      confirmations,
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_RECONCILE_BY_TX', 'Deposit', parsed.data.txHash, {
      chain: chainCfg.id,
      txHash: parsed.data.txHash,
      from: tx.from,
      to: tx.to,
      valueWei: tx.value.toString(),
      confirmations,
      result,
    })

    return reply.send({ success: true, data: { result, onChain: { confirmations, currentBlock: currentBlock.toString(), txBlock: receipt.blockNumber.toString() } } })
  })

  // POST /admin/deposits/:id/reject — mark a Deposit row as rejected.
  // Used when a deposit was a false positive (e.g. test-net leak, internal
  // sweep, spam token). Reversible via force-credit. Heavily audit-logged.
  app.post('/admin/deposits/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({ reason: z.string().min(10).max(500) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Reason is required (10-500 chars)', 400)

    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')
    if (deposit.status === 'credited') {
      throw new AppError('ALREADY_CREDITED', 'Cannot reject an already-credited deposit. Open a manual reversal ticket instead.', 409)
    }

    await db.deposit.update({
      where: { id: deposit.id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason.slice(0, 500) },
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_REJECTED', 'Deposit', deposit.id, {
      reason: parsed.data.reason,
      txHash: deposit.txHash,
      chain: deposit.chain,
    })

    return reply.send({ success: true })
  })

  // GET /admin/deposits — paginated on-chain deposit history with filters.
  // Returns the full Deposit + DepositAddress audit trail so ops can debug
  // stuck/pending credits, failed crediting, suspicious addresses, etc.
  app.get('/admin/deposits', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status
    if (query.chain) where.chain = query.chain
    if (query.userId) where.userId = query.userId
    if (query.toAddress) where.toAddress = query.toAddress

    const [deposits, total] = await Promise.all([
      db.deposit.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.deposit.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { deposits, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/deposit-addresses — audit who owns which HD-derived address.
  app.get('/admin/deposit-addresses', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.chainFamily) where.chainFamily = query.chainFamily
    if (query.userId) where.userId = query.userId
    if (query.address) where.address = query.address

    const [addresses, total] = await Promise.all([
      db.depositAddress.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.depositAddress.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { addresses, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

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
