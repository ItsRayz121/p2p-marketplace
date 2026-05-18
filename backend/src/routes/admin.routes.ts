import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { env } from '../lib/env'
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
import { getWithdrawalTierConfig, upsertWithdrawalTierConfig } from '../services/withdrawal-risk.service'
import { getNativeUsdPrice, testRpcHealth, getHotWalletBalance } from '../lib/gas/gas.balance'
import { getAllTreasuryAddresses, getTreasuryBalance } from '../lib/gas/gas.treasury'
import { getLedgerEntries, getLedgerSummary } from '../lib/gas/gas.ledger'
import { getAllThresholds, getThreshold, upsertThreshold, setThresholdEnabled, validateThreshold } from '../lib/gas/gas.thresholds'
import { approveRefill, cancelRefill, checkAndQueueRefills, processApprovedRefills } from '../lib/gas/gas.refill'
import { getTronHotWalletAddress, getEvmHotWalletAddress, getTronTreasuryAddress, getEvmTreasuryAddress } from '../lib/gas/gasWalletService'
import type { GasChainId } from '../lib/gas/gas.chains'
import { listReconciliationRuns, getReconciliationRun, resolveDiscrepancy } from '../lib/gas/gas.reconciliation'
import { getChainBurnRates, getChainRunways, getProfitabilityByChain, getVolumeTimeSeries } from '../lib/gas/gas.analytics'
import { listFlaggedOrders, reviewFlaggedOrder } from '../lib/gas/gas.risk'
import { listMerchantAccounts, createMerchantAccount, updateMerchantAccount, getMerchantAccount, listMerchantSettlements, approveSettlement } from '../lib/gas/gas.merchant-settlement'
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

  // Tier-aware approve: tier 1/2 → single approval; tier 3/4 → dual approval.
  app.post('/admin/withdrawals/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = req.user!.id

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (!['pending', 'first_approved'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Withdrawal is in status '${withdrawal.status}' and cannot be approved`, 400)
    }

    const tier = withdrawal.tier ?? 3

    if (withdrawal.status === 'pending') {
      if (tier <= 2) {
        // Single-admin approval path (tier 1 escalated by risk flags, or tier 2).
        // Optimistic lock: include status in WHERE so concurrent approvals are idempotent.
        const updated = await db.withdrawal.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'approved', firstApprovedBy: adminId },
        })
        if (updated.count === 0) {
          throw new AppError('CONFLICT', 'Withdrawal was already approved by another admin', 409)
        }
        await createAuditLog(adminId, 'WITHDRAWAL_APPROVED', 'Withdrawal', id, { tier, singleApproval: true })
        return reply.send({ success: true, message: 'Withdrawal approved and ready to send.' })
      } else {
        // Dual-approval path (tier 3+): first approval with optimistic lock.
        const updated = await db.withdrawal.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'first_approved', firstApprovedBy: adminId },
        })
        if (updated.count === 0) {
          throw new AppError('CONFLICT', 'Withdrawal status changed concurrently — please refresh and try again', 409)
        }
        await createAuditLog(adminId, 'WITHDRAWAL_FIRST_APPROVED', 'Withdrawal', id, { tier })
        return reply.send({ success: true, message: 'First approval recorded. A second admin must approve before it can be sent.' })
      }
    }

    // status === 'first_approved' — always requires a different admin
    if (withdrawal.firstApprovedBy === adminId) {
      throw new AppError('SAME_ADMIN', 'A different admin must provide the second approval', 403)
    }
    // Optimistic lock: re-validate status is still first_approved when we commit.
    const updated = await db.withdrawal.updateMany({
      where: { id, status: 'first_approved' },
      data: { status: 'approved', secondApprovedBy: adminId },
    })
    if (updated.count === 0) {
      throw new AppError('CONFLICT', 'Withdrawal status changed concurrently — please refresh and try again', 409)
    }
    await createAuditLog(adminId, 'WITHDRAWAL_SECOND_APPROVED', 'Withdrawal', id, { tier })
    return reply.send({ success: true, message: 'Withdrawal fully approved and ready to send.' })
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
    if (['completed', 'sent'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', 'Cannot reject a completed or sent withdrawal', 400)
    }

    // email_pending withdrawals never had their balance deducted — do not refund.
    const balanceWasDeducted = withdrawal.status !== 'email_pending'

    await db.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst({
        where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
        select: { id: true },
      })

      await tx.withdrawal.update({
        where: { id },
        data: { status: 'rejected', rejectedBy: req.user!.id, rejectionReason: parsed.data.reason },
      })

      if (balanceWasDeducted) {
        await tx.wallet.updateMany({
          where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
          data: { balance: { increment: new Prisma.Decimal(Number(withdrawal.amount) + Number(withdrawal.fee)) } },
        })

        if (wallet) {
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              type: 'withdrawal',
              amount: withdrawal.amount,
              fee: withdrawal.fee,
              status: 'failed',
              metadata: {
                withdrawalId: withdrawal.id,
                orderRef: withdrawal.orderRef,
                toAddress: withdrawal.toAddress,
                rejectionReason: parsed.data.reason,
                rejectedBy: req.user!.id,
                refunded: true,
              } as JsonValue,
            },
          })
        }
      }
    })

    await createAuditLog(req.user!.id, 'WITHDRAWAL_REJECTED', 'Withdrawal', id, { reason: parsed.data.reason })
    await sendWithdrawalEmail('rejected', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      reason: parsed.data.reason,
    })

    return reply.send({ success: true })
  })

  // Place a withdrawal on security hold (any non-terminal status → on_hold).
  app.post('/admin/withdrawals/:id/hold', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['email_pending', 'sent', 'completed', 'rejected', 'cancelled', 'on_hold'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Cannot hold a withdrawal in status '${withdrawal.status}'`, 400)
    }

    await db.withdrawal.update({
      where: { id },
      data: { status: 'on_hold', onHoldBy: req.user!.id, onHoldReason: parsed.data.reason },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_HELD', 'Withdrawal', id, { reason: parsed.data.reason })
    return reply.send({ success: true, message: 'Withdrawal placed on hold.' })
  })

  // Release a held withdrawal back to pending for normal approval flow.
  app.post('/admin/withdrawals/:id/release-hold', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (withdrawal.status !== 'on_hold') {
      throw new AppError('INVALID_STATUS', 'Withdrawal is not on hold', 400)
    }

    await db.withdrawal.update({
      where: { id },
      data: {
        status: 'pending',
        // Reset approval chain so it goes through full approval flow from the top
        firstApprovedBy: null,
        secondApprovedBy: null,
      },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_HOLD_RELEASED', 'Withdrawal', id, {})
    return reply.send({ success: true, message: 'Hold released. Withdrawal returned to pending.' })
  })

  // Admin risk override: acknowledge risk flags and reduce effective tier.
  // Useful when a first-withdrawal by a known/trusted user is safe to approve faster.
  app.post('/admin/withdrawals/:id/risk-override', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      note: z.string().min(1).max(500),
      overrideTier: z.number().int().min(1).max(4).optional(),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['sent', 'completed', 'rejected', 'cancelled'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', 'Cannot override risk on a terminal withdrawal', 400)
    }

    const newTier = parsed.data.overrideTier ?? withdrawal.tier
    await db.withdrawal.update({
      where: { id },
      data: {
        riskOverride: true,
        riskOverrideBy: req.user!.id,
        riskOverrideNote: parsed.data.note,
        tier: newTier,
      },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_RISK_OVERRIDE', 'Withdrawal', id, {
      note: parsed.data.note,
      originalTier: withdrawal.tier,
      newTier,
    })
    return reply.send({ success: true, message: 'Risk override applied.' })
  })

  // POST /admin/withdrawals/:id/mark-sent — operator calls this after manually
  // broadcasting the on-chain payout. Accepts both 'approved' and 'auto_approved'.
  app.post('/admin/withdrawals/:id/mark-sent', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({
      txHash: z.string().min(1).max(200),
      adminNote: z.string().max(500).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (!['approved', 'auto_approved'].includes(withdrawal.status)) {
      throw new AppError(
        'INVALID_STATUS',
        `Withdrawal must be 'approved' or 'auto_approved' to mark as sent (current: ${withdrawal.status})`,
        400,
      )
    }

    const wallet = await db.wallet.findFirst({
      where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
      select: { id: true },
    })

    await db.$transaction(async (tx) => {
      // Optimistic lock inside the transaction: only update if status is still
      // approved/auto_approved. Guards against two concurrent mark-sent calls
      // both creating a completed Transaction row for the same withdrawal.
      const locked = await tx.withdrawal.updateMany({
        where: { id, status: { in: ['approved', 'auto_approved'] } },
        data: {
          status: 'sent',
          txHash: parsed.data.txHash,
          completedAt: new Date(),
          ...(parsed.data.adminNote ? { adminNote: parsed.data.adminNote } : {}),
        },
      })
      if (locked.count === 0) {
        throw new AppError('CONFLICT', 'Withdrawal was already marked as sent by another admin', 409)
      }

      if (wallet) {
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'withdrawal',
            amount: withdrawal.amount,
            fee: withdrawal.fee,
            txHash: parsed.data.txHash,
            status: 'completed',
            metadata: {
              withdrawalId: withdrawal.id,
              orderRef: withdrawal.orderRef,
              toAddress: withdrawal.toAddress,
              markedSentBy: req.user!.id,
              ...(parsed.data.adminNote ? { adminNote: parsed.data.adminNote } : {}),
            } as JsonValue,
          },
        })
      }
    })

    log.info(
      { adminId: req.user!.id, withdrawalId: id, txHash: parsed.data.txHash, coin: withdrawal.coin },
      'Withdrawal marked as sent',
    )

    await createAuditLog(req.user!.id, 'WITHDRAWAL_MARKED_SENT', 'Withdrawal', id, {
      txHash: parsed.data.txHash,
      adminNote: parsed.data.adminNote,
      userId: withdrawal.userId,
      coin: withdrawal.coin,
      amount: withdrawal.amount.toString(),
      toAddress: withdrawal.toAddress,
    })

    await sendWithdrawalEmail('approved', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      txHash: parsed.data.txHash,
    }).catch(() => {})

    return reply.send({ success: true, data: { status: 'sent', txHash: parsed.data.txHash } })
  })

  // GET /admin/withdrawal-tiers — read current tier thresholds + risk config
  app.get('/admin/withdrawal-tiers', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const config = await getWithdrawalTierConfig(db)
    return reply.send({ success: true, data: config })
  })

  // PUT /admin/withdrawal-tiers — update tier thresholds + risk config
  app.put('/admin/withdrawal-tiers', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      tier1MaxUsd: z.number().positive().optional(),
      tier2MaxUsd: z.number().positive().optional(),
      tier3MaxUsd: z.number().positive().optional(),
      autoApproveEnabled: z.boolean().optional(),
      firstWithdrawalReview: z.boolean().optional(),
      newWalletReview: z.boolean().optional(),
      velocityWindowMins: z.number().int().min(1).optional(),
      velocityMaxCount: z.number().int().min(1).optional(),
      coinPricesUsd: z.record(z.string(), z.number().positive()).optional(),
      emailConfirmationEnabled: z.boolean().optional(),
      emailConfirmationTtlMins: z.number().int().min(1).max(1440).optional(),
      addressActivationHours: z.number().int().min(0).max(168).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const updated = await upsertWithdrawalTierConfig(db, { ...parsed.data, updatedBy: req.user!.id })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_TIERS_UPDATED', 'WithdrawalTierConfig', '1', parsed.data)
    return reply.send({ success: true, data: updated })
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

  // GET /admin/wallet/status — aggregated platform wallet status for admin UI
  app.get('/admin/wallet/status', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { gasWalletIsConfigured, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')

    const mnemonicConfigured = gasWalletIsConfigured()
    const evmHotWallet = mnemonicConfigured ? getEvmHotWalletAddress() : null

    // Deposit addresses: DB override → ENV var → mnemonic-derived (for EVM chains)
    const envDepositMap: Array<{ coin: string; network: string; envVar: string; chain: string; evmFallback?: boolean }> = [
      { coin: 'USDT', network: 'TRC20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_TRC20', chain: 'TRON' },
      { coin: 'USDT', network: 'BEP20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_BEP20', chain: 'BSC',  evmFallback: true },
      { coin: 'USDT', network: 'ERC20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_ERC20', chain: 'ETH',  evmFallback: true },
    ]

    const dbAddresses = await db.platformConfig.findMany({
      where: { key: { startsWith: 'deposit_address_' } },
    })
    const dbMap = Object.fromEntries(dbAddresses.map((r) => [r.key, r]))

    const depositAddresses = envDepositMap.map(({ coin, network, envVar, chain, evmFallback }) => {
      const dbKey   = `deposit_address_${coin.toLowerCase()}_${network.toLowerCase()}`
      const dbEntry = dbMap[dbKey]
      const envValue = (env as unknown as Record<string, string | undefined>)[envVar]
      // Priority: DB override → ENV var → mnemonic-derived EVM address
      const mnemonicValue = (evmFallback && evmHotWallet) ? evmHotWallet : null
      const address = dbEntry?.value ?? envValue ?? mnemonicValue ?? null
      const source  = dbEntry ? 'db' : envValue ? 'env' : mnemonicValue ? 'mnemonic' : null
      return {
        coin,
        network,
        chain,
        address,
        source,
        configured: !!address,
        updatedAt: dbEntry?.updatedAt ?? null,
      }
    })

    // Hot wallets with balances from cache
    const allWallets = await db.gasHotWallet.findMany()
    const chainThresholds = await db.gasChainConfig.findMany({
      where: { backendChainId: { not: null } },
      select: { backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const thresholdMap = Object.fromEntries(chainThresholds.map((c) => [c.backendChainId!, c]))
    const hotWallets = await Promise.all(
      allWallets.map(async (w) => {
        const chainConfig = GAS_CHAINS[fromDbChain(w.chain)]
        const [balanceCached, isPaused, balanceUsdCached] = await Promise.all([
          redisClient.get(`gas_wallet_balance:${w.chain}`),
          redisClient.get(`gas_wallet_paused:${w.chain}`),
          redisClient.get(`gas_wallet_balance_usd:${w.chain}`),
        ])
        const balance = balanceCached ? parseFloat(balanceCached) : null
        const cfg = thresholdMap[w.chain as string]
        const alertThresholdUsd = cfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = cfg?.pauseThresholdUsd ?? null
        const balanceUsd = balanceUsdCached
          ? parseFloat(balanceUsdCached)
          : balance !== null && chainConfig
          ? await getNativeUsdPrice(fromDbChain(w.chain)).then((p) => balance * p).catch(() => null)
          : null
        let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'healthy'
        if (!w.isActive || isPaused) status = 'paused'
        else if (balanceUsd === null) status = 'unavailable'
        else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) status = 'paused'
        else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'
        return {
          chain:                w.chain,
          address:              w.address,
          isActive:             w.isActive,
          balance,
          balanceUsd,
          nativeSymbol:         chainConfig?.nativeSymbol ?? w.chain,
          alertThresholdUsd,
          pauseThresholdUsd,
          status,
          lastBalanceRefreshAt: w.lastBalanceRefreshAt ?? null,
        }
      }),
    )

    // Gas order summary by status
    const statusGroups = await db.gasFeeOrder.groupBy({
      by: ['status'],
      _count: { status: true },
    })
    const orderSummary = Object.fromEntries(statusGroups.map((g) => [g.status, g._count.status])) as Record<string, number>

    // Config warnings: flag missing env vars. Mnemonic system is now required.
    const requiredEnvChecks: Array<{ key: string; label: string; required: boolean }> = [
      { key: 'GAS_MASTER_KEY',                 label: 'Gas wallet master key (mnemonic)', required: true  },
      { key: 'GAS_SEED_CIPHERTEXT',            label: 'Gas wallet seed ciphertext',       required: true  },
      { key: 'GAS_FEE_DEPOSIT_ADDRESS_TRC20',  label: 'TRON deposit address',             required: true  },
      { key: 'TRON_FULLNODE_URL',              label: 'TRON full node URL',               required: true  },
      { key: 'TRONGRID_API_KEY',               label: 'TronGrid API key',                 required: false },
      { key: 'GAS_FEE_DEPOSIT_ADDRESS_BEP20',  label: 'BSC deposit address',              required: false },
      { key: 'GAS_FEE_DEPOSIT_ADDRESS_ERC20',  label: 'ETH deposit address',              required: false },
    ]
    const configWarnings = requiredEnvChecks
      .filter(({ key }) => !(env as unknown as Record<string, string | undefined>)[key])
      .map(({ key, label, required }) => ({ key, label, required }))

    return reply.send({
      success: true,
      data: {
        depositAddresses,
        hotWallets,
        orderSummary,
        configWarnings,
        mnemonicConfigured,
        evmHotWallet,
      },
    })
  })

  // ── Audit Log ──────────────────────────────────────────────────────────────

  app.get('/admin/audit-log', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { limit, skip } = paginationParams(query)

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

    const entries = logs.map((l) => ({
      id:        l.id,
      userId:    l.actorId,
      user:      l.actor,
      action:    l.action,
      details:   l.metadata,
      createdAt: l.createdAt,
    }))

    return reply.send({
      success: true,
      data: { entries, total },
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

    // CAS: only transition failed → payment_detected. Concurrent retries will
    // find count=0 on the second call and hit the conflict branch below.
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: 'failed' },
      data: { status: 'payment_detected', failureReason: null, retryCount: { increment: 1 } },
    })

    if (claimed.count === 0) {
      const order = await db.gasFeeOrder.findUnique({ where: { id } })
      if (!order) throw Errors.NOT_FOUND('Gas fee order')
      throw new AppError('CONFLICT', `Order is in '${order.status}' — only failed orders can be retried`, 409)
    }

    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_ORDER_RETRY', 'GasFeeOrder', id, { previousStatus: 'failed' })

    return reply.send({ success: true })
  })

  app.post('/admin/gas/orders/:id/refund', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    if (order.status !== 'failed') {
      throw new AppError(
        'INVALID_STATUS',
        `Cannot refund an order with status '${order.status}'. Only failed orders can be refunded.`,
        400,
      )
    }

    await db.gasFeeOrder.update({
      where: { id },
      data: { status: 'refunded', refundedAt: new Date() },
    })
    await createAuditLog(req.user!.id, 'GAS_ORDER_REFUNDED', 'GasFeeOrder', id, {
      previousStatus: order.status,
      orderRef: order.orderRef,
    })

    return reply.send({ success: true })
  })

  // GET /admin/gas/orders/:ref — order detail
  app.get('/admin/gas/orders/:ref', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef: ref },
      include: { user: { select: { username: true, email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({ success: true, data: order })
  })

  // GET /admin/gas/stats — today's metrics + all hot wallet statuses
  app.get('/admin/gas/stats', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [todayOrders, todayRevenue, pendingCount, failedCount, refundPendingCount, pendingCustomRequests, allWallets] = await Promise.all([
      db.gasFeeOrder.count({ where: { createdAt: { gte: today } } }),
      db.gasFeeOrder.aggregate({
        where: { status: 'delivered', deliveredAt: { gte: today } },
        _sum: { paymentAmount: true },
      }),
      db.gasFeeOrder.count({ where: { status: { in: ['payment_pending', 'payment_uploaded', 'payment_detected', 'sending'] } } }),
      db.gasFeeOrder.count({ where: { status: 'failed' } }),
      db.gasFeeOrder.count({ where: { status: 'refund_pending' } }),
      db.gasCustomRequest.count({ where: { status: 'pending' } }),
      db.gasHotWallet.findMany(),
    ])

    const statsThresholds = await db.gasChainConfig.findMany({
      where: { backendChainId: { not: null } },
      select: { backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const statsThresholdMap = Object.fromEntries(statsThresholds.map((c) => [c.backendChainId!, c]))
    const wallets = await Promise.all(
      allWallets.map(async (w) => {
        const chainConfig = GAS_CHAINS[fromDbChain(w.chain)]
        const [balanceCached, isPaused, balanceUsdCached] = await Promise.all([
          redisClient.get(`gas_wallet_balance:${w.chain}`),
          redisClient.get(`gas_wallet_paused:${w.chain}`),
          redisClient.get(`gas_wallet_balance_usd:${w.chain}`),
        ])
        const balance = balanceCached ? parseFloat(balanceCached) : null
        const cfg = statsThresholdMap[w.chain as string]
        const alertThresholdUsd = cfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = cfg?.pauseThresholdUsd ?? null
        const balanceUsd = balanceUsdCached
          ? parseFloat(balanceUsdCached)
          : balance !== null && chainConfig
          ? await getNativeUsdPrice(fromDbChain(w.chain)).then((p) => balance * p).catch(() => null)
          : null
        let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'healthy'
        if (!w.isActive || isPaused) status = 'paused'
        else if (balanceUsd === null) status = 'unavailable'
        else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) status = 'paused'
        else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'
        return {
          chain:                w.chain,
          address:              w.address,
          isActive:             w.isActive,
          balance,
          balanceUsd,
          nativeSymbol:         chainConfig?.nativeSymbol ?? w.chain,
          status,
          alertThresholdUsd,
          pauseThresholdUsd,
          lastBalanceRefreshAt: w.lastBalanceRefreshAt ?? null,
        }
      }),
    )

    // Backward-compat: surface TRON wallet as primary `wallet` field
    const tronWallet = wallets.find((w) => w.chain === 'TRON') ?? null

    return reply.send({
      success: true,
      data: {
        todayOrders,
        todayRevenue: todayRevenue._sum.paymentAmount ?? 0,
        pendingCount,
        failedCount,
        refundPendingCount,
        pendingCustomRequests,
        wallet: tronWallet,
        wallets,
      },
    })
  })

  // GET /admin/gas/wallets — list hot wallets with cached balances
  app.get('/admin/gas/wallets', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')

    const wallets = await db.gasHotWallet.findMany()
    const walletsWithBalance = await Promise.all(
      wallets.map(async (w) => {
        const balanceCached = await redisClient.get(`gas_wallet_balance:${w.chain}`)
        const isPaused = await redisClient.get(`gas_wallet_paused:${w.chain}`)
        return {
          ...w,
          balanceTRX: balanceCached ? parseFloat(balanceCached) : null,
          isAutoPaused: !!isPaused,
        }
      }),
    )
    return reply.send({ success: true, data: { wallets: walletsWithBalance } })
  })

  // POST /admin/gas/wallets/:chain/balance — manually override cached balance (super_admin)
  app.post('/admin/gas/wallets/:chain/balance', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { balanceTRX } = req.body as { balanceTRX: number }
    if (typeof balanceTRX !== 'number' || balanceTRX < 0) {
      throw new AppError('VALIDATION_ERROR', 'balanceTRX must be a non-negative number', 400)
    }

    const { redis: redisClient } = await import('../lib/redis')
    await redisClient.set(`gas_wallet_balance:${chain}`, String(balanceTRX), 'EX', 1800)
    await createAuditLog(req.user!.id, 'GAS_WALLET_BALANCE_OVERRIDE', 'GasHotWallet', chain, { balanceTRX })

    return reply.send({ success: true })
  })

  // POST /admin/gas/wallets/:chain/refresh-balance — fetch live balance and update Redis cache (admin)
  app.post('/admin/gas/wallets/:chain/refresh-balance', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { getHotWalletBalance } = await import('../lib/gas/gas.balance')

    const wallet = await db.gasHotWallet.findFirst({ where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON', hdIndex: 0 } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    const chainId = fromDbChain(chain)
    const chainConfig = GAS_CHAINS[chainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `Balance fetch not supported for ${chain}`, 400)

    let balance: number
    try {
      balance = await getHotWalletBalance(chainId, wallet.address)
    } catch (err) {
      throw new AppError('BALANCE_FETCH_FAILED', `Failed to fetch ${chain} balance: ${err instanceof Error ? err.message : String(err)}`, 502)
    }

    await redisClient.set(`gas_wallet_balance:${chain}`, String(balance), 'EX', 1800)
    await Promise.all([
      createAuditLog(req.user!.id, 'GAS_WALLET_BALANCE_REFRESHED', 'GasHotWallet', wallet.id, { chain, balance }),
      db.gasHotWallet.update({ where: { id: wallet.id }, data: { lastBalanceRefreshAt: new Date() } }),
    ])

    const isPaused = await redisClient.get(`gas_wallet_paused:${chain}`)
    const dbThreshold = await db.gasChainConfig.findFirst({
      where: { backendChainId: chain },
      select: { alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const alertThresholdUsd = dbThreshold?.alertThresholdUsd ?? null
    const pauseThresholdUsd = dbThreshold?.pauseThresholdUsd ?? null
    const usdPrice = await getNativeUsdPrice(chainId).catch(() => 0)
    const balanceUsd = usdPrice > 0 ? balance * usdPrice : null
    if (balanceUsd !== null) {
      await redisClient.set(`gas_wallet_balance_usd:${chain}`, String(balanceUsd.toFixed(4)), 'EX', 1800)
    }
    let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'healthy'
    if (!wallet.isActive || isPaused) status = 'paused'
    else if (balanceUsd === null) status = 'unavailable'
    else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) status = 'paused'
    else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'

    return reply.send({
      success: true,
      data: { chain, balance, balanceUsd, nativeSymbol: chainConfig.nativeSymbol, status, alertThresholdUsd, pauseThresholdUsd },
    })
  })

  // POST /admin/gas/chains/:chain/toggle — pause/resume a chain (super_admin)
  app.post('/admin/gas/chains/:chain/toggle', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }

    // Validate chain exists in DB — toggle ALL wallets for the chain
    const wallet = await db.gasHotWallet.findFirst({ where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON', hdIndex: 0 } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    // Toggle all wallets for this chain together
    const newIsActive = !wallet.isActive
    await db.gasHotWallet.updateMany({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' },
      data: { isActive: newIsActive },
    })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_TOGGLED', 'GasHotWallet', wallet.id, {
      chain,
      isActive: newIsActive,
    })

    return reply.send({ success: true, data: { chain, isActive: newIsActive } })
  })

  // GET /admin/gas/unattributed — payments received with no matching order
  app.get('/admin/gas/unattributed', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')

    // Sorted set: members are JSON strings, scores are epoch timestamps
    const raw = await redisClient.zrevrange('gas_unattributed', 0, 49)
    const payments = raw.flatMap((entry) => {
      try { return [JSON.parse(entry) as Record<string, unknown>] } catch { return [] }
    })
    return reply.send({ success: true, data: { payments, total: payments.length } })
  })

  // POST /admin/gas/unattributed/:txHash/attribute — link an unattributed payment to an order
  app.post('/admin/gas/unattributed/:txHash/attribute', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { txHash } = req.params as { txHash: string }
    const { orderId } = req.body as { orderId: string }
    if (!orderId) throw new AppError('VALIDATION_ERROR', 'orderId is required', 400)

    const { redis: redisClient } = await import('../lib/redis')

    // Find and remove the matching entry from the sorted set
    const raw = await redisClient.zrevrange('gas_unattributed', 0, 99)
    for (const entry of raw) {
      try {
        const parsed = JSON.parse(entry) as { txHash?: string }
        if (parsed.txHash === txHash) {
          await redisClient.zrem('gas_unattributed', entry)
          break
        }
      } catch { /* skip malformed entries */ }
    }

    // Update the gas order to payment_detected and enqueue delivery
    const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'payment_detected', paymentTxHash: txHash },
    })
    await queues.gasFee.add('deliver', { orderId }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_UNATTRIBUTED_ATTRIBUTED', 'GasFeeOrder', orderId, { txHash })

    return reply.send({ success: true })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GAS CHAIN CONFIG CRUD
  // ─────────────────────────────────────────────────────────────────────────

  // GET /admin/gas/chains — list all chains (including inactive)
  app.get('/admin/gas/chains', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const chains = await db.gasChainConfig.findMany({
      orderBy: { displayOrder: 'asc' },
      include: {
        _count: { select: { tokens: true } },
        tokens: { orderBy: { displayOrder: 'asc' } },
      },
    })
    return reply.send({ success: true, data: { chains } })
  })

  // POST /admin/gas/chains — create a new chain
  app.post('/admin/gas/chains', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      name:               z.string().min(1),
      slug:               z.string().min(1),
      symbol:             z.string().min(1),
      category:           z.string().min(1),
      networkLabel:       z.string().min(1),
      addressType:        z.enum(['TRC20', 'EVM', 'SOL', 'SUI', 'TON']),
      logoUrl:            z.string().url().nullable().default(null),
      explorerBase:       z.string().url().nullable().default(null),
      backendChainId:     z.string().nullable().default(null),
      platformFeePercent: z.number().min(0).max(100).default(10),
      alertThresholdUsd:  z.number().positive().nullable().default(null),
      pauseThresholdUsd:  z.number().positive().nullable().default(null),
      isActive:           z.boolean().default(false),
      readinessState:     z.enum(['inactive', 'testing', 'beta', 'stable']).default('inactive'),
      displayOrder:       z.number().int().default(0),
    })
    const d = schema.parse(req.body)
    const chain = await db.gasChainConfig.create({
      data: {
        name: d.name, slug: d.slug.toUpperCase(), symbol: d.symbol,
        category: d.category, networkLabel: d.networkLabel, addressType: d.addressType,
        logoUrl: d.logoUrl, explorerBase: d.explorerBase,
        backendChainId: d.backendChainId, platformFeePercent: d.platformFeePercent,
        alertThresholdUsd: d.alertThresholdUsd, pauseThresholdUsd: d.pauseThresholdUsd,
        isActive: d.isActive, readinessState: d.readinessState, displayOrder: d.displayOrder,
      },
    })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_CREATED', 'GasChainConfig', chain.id, { slug: chain.slug })
    return reply.code(201).send({ success: true, data: chain })
  })

  // PATCH /admin/gas/chains/:id — update chain
  app.patch('/admin/gas/chains/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const chain = await db.gasChainConfig.findUnique({ where: { id }, include: { _count: { select: { tokens: true } } } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    const body = req.body as Record<string, unknown>
    // Build update data only with keys present in body, converting undefined nullable → null
    const updateData: Record<string, unknown> = {}
    if ('name' in body) updateData.name = body.name
    if ('symbol' in body) updateData.symbol = body.symbol
    if ('category' in body) updateData.category = body.category
    if ('networkLabel' in body) updateData.networkLabel = body.networkLabel
    if ('addressType' in body) updateData.addressType = body.addressType
    if ('logoUrl' in body) updateData.logoUrl = body.logoUrl ?? null
    if ('explorerBase' in body) updateData.explorerBase = body.explorerBase ?? null
    if ('backendChainId' in body) updateData.backendChainId = body.backendChainId ?? null
    if ('platformFeePercent' in body) updateData.platformFeePercent = Math.min(100, Math.max(0, Number(body.platformFeePercent) || 10))
    if ('alertThresholdUsd' in body) updateData.alertThresholdUsd = body.alertThresholdUsd != null ? Math.max(0, Number(body.alertThresholdUsd)) : null
    if ('pauseThresholdUsd' in body) updateData.pauseThresholdUsd = body.pauseThresholdUsd != null ? Math.max(0, Number(body.pauseThresholdUsd)) : null
    if ('isActive' in body) updateData.isActive = body.isActive
    if ('displayOrder' in body) updateData.displayOrder = Number(body.displayOrder) || 0
    if ('readinessState' in body) {
      const validStates = ['inactive', 'testing', 'beta', 'stable']
      const state = String(body.readinessState)
      if (!validStates.includes(state)) throw new AppError('VALIDATION_ERROR', `readinessState must be one of: ${validStates.join(', ')}`, 400)
      updateData.readinessState = state
    }

    // ── Activation guardrails: refuse to enable a chain that isn't operationally ready ──
    const activating = updateData.isActive === true && chain.isActive === false
    if (activating) {
      const effectiveBackendId = (updateData.backendChainId as string | null | undefined) ?? chain.backendChainId
      const effectiveExplorer  = (updateData.explorerBase  as string | null | undefined) ?? chain.explorerBase

      const failures: string[] = []

      if (!effectiveBackendId) {
        failures.push('backendChainId is not set — delivery is not wired for this chain')
      } else {
        // Hot wallet must exist and be active in DB
        const dbChain = effectiveBackendId === 'ETHEREUM' ? 'ETH' : effectiveBackendId
        const hotWallet = await db.gasHotWallet.findFirst({
          where: { chain: dbChain as 'TRON' | 'BSC' | 'ETH' | 'BASE' | 'ARB' | 'OP' | 'MATIC' | 'AVAX' | 'SOL' | 'TON' | 'SUI', isActive: true },
        })
        if (!hotWallet) failures.push(`No active GasHotWallet row for chain ${effectiveBackendId}`)

        // Live balance fetch must succeed
        if (hotWallet) {
          const { fromDbChain: fdc, GAS_CHAINS } = await import('../lib/gas/gas.chains')
          const { getHotWalletBalance } = await import('../lib/gas/gas.balance')
          try {
            const chainId = fdc(dbChain)
            if (GAS_CHAINS[chainId]) await getHotWalletBalance(chainId, hotWallet.address)
          } catch {
            failures.push(`Balance fetch failed for ${effectiveBackendId} — RPC may be unreachable`)
          }
        }
      }

      if (!effectiveExplorer) failures.push('explorerBase is not configured')
      if (chain._count.tokens === 0) failures.push('No token configs exist for this chain')

      if (failures.length > 0) {
        throw new AppError(
          'CHAIN_NOT_READY',
          `Cannot activate chain — ${failures.length} prerequisite(s) not met:\n• ${failures.join('\n• ')}`,
          422,
        )
      }
    }

    const updated = await db.gasChainConfig.update({ where: { id }, data: updateData })

    // Fine-grained audit: log threshold changes and activation separately
    if ('alertThresholdUsd' in updateData || 'pauseThresholdUsd' in updateData) {
      await createAuditLog(req.user!.id, 'GAS_CHAIN_THRESHOLD_EDITED', 'GasChainConfig', id, {
        slug: chain.slug,
        alertThresholdUsd: updateData.alertThresholdUsd ?? chain.alertThresholdUsd,
        pauseThresholdUsd: updateData.pauseThresholdUsd ?? chain.pauseThresholdUsd,
        prev_alertThresholdUsd: chain.alertThresholdUsd,
        prev_pauseThresholdUsd: chain.pauseThresholdUsd,
      })
    }
    if ('isActive' in updateData) {
      await createAuditLog(req.user!.id, activating ? 'GAS_CHAIN_ACTIVATED' : 'GAS_CHAIN_DEACTIVATED', 'GasChainConfig', id, {
        slug: chain.slug, isActive: updateData.isActive,
      })
    }
    await createAuditLog(req.user!.id, 'GAS_CHAIN_UPDATED', 'GasChainConfig', id, updateData)
    return reply.send({ success: true, data: updated })
  })

  // DELETE /admin/gas/chains/:id — delete chain (only if no orders reference its tokens)
  app.delete('/admin/gas/chains/:id', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const chain = await db.gasChainConfig.findUnique({ where: { id }, include: { tokens: { select: { id: true } } } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    const tokenIds = chain.tokens.map((t) => t.id)
    if (tokenIds.length > 0) {
      const orderCount = await db.gasFeeOrder.count({ where: { gasTokenConfigId: { in: tokenIds } } })
      if (orderCount > 0) {
        throw new AppError('CONFLICT', `Cannot delete chain — ${orderCount} orders reference its tokens`, 409)
      }
    }

    await db.gasChainConfig.delete({ where: { id } })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_DELETED', 'GasChainConfig', id, { slug: chain.slug })
    return reply.send({ success: true })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GAS TOKEN CONFIG CRUD
  // ─────────────────────────────────────────────────────────────────────────

  // GET /admin/gas/tokens — list all tokens, optionally filtered by chainId
  app.get('/admin/gas/tokens', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chainId } = req.query as { chainId?: string }
    const tokens = await db.gasTokenConfig.findMany({
      where: chainId ? { chainConfigId: chainId } : {},
      orderBy: [{ chain: { displayOrder: 'asc' } }, { displayOrder: 'asc' }],
      include: { chain: { select: { name: true, slug: true } } },
    })
    return reply.send({ success: true, data: { tokens } })
  })

  // POST /admin/gas/tokens — create token
  app.post('/admin/gas/tokens', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      chainConfigId:   z.string().min(1),
      name:            z.string().min(1),
      symbol:          z.string().min(1),
      tokenType:       z.enum(['native', 'token']),
      contractAddress: z.string().nullable().default(null),
      logoUrl:         z.string().url().nullable().default(null),
      priceSymbol:     z.string().min(1),
      minAmount:       z.number().positive().default(0.1),
      maxUsdValue:     z.number().positive().default(10),
      presetAmounts:   z.array(z.number().positive()).min(1),
      isActive:        z.boolean().default(true),
      displayOrder:    z.number().int().default(0),
    })
    const d = schema.parse(req.body)
    const chain = await db.gasChainConfig.findUnique({ where: { id: d.chainConfigId } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    const token = await db.gasTokenConfig.create({
      data: {
        chainConfigId: d.chainConfigId, name: d.name, symbol: d.symbol,
        tokenType: d.tokenType, contractAddress: d.contractAddress, logoUrl: d.logoUrl,
        priceSymbol: d.priceSymbol, minAmount: d.minAmount, maxUsdValue: d.maxUsdValue,
        presetAmounts: d.presetAmounts, isActive: d.isActive, displayOrder: d.displayOrder,
      },
    })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_CREATED', 'GasTokenConfig', token.id, { symbol: token.symbol, chain: chain.slug })
    return reply.code(201).send({ success: true, data: token })
  })

  // PATCH /admin/gas/tokens/:id — update token
  app.patch('/admin/gas/tokens/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const token = await db.gasTokenConfig.findUnique({ where: { id } })
    if (!token) throw Errors.NOT_FOUND('Gas token config')

    const body = req.body as Record<string, unknown>
    const updateData: Record<string, unknown> = {}
    if ('name' in body) updateData.name = body.name
    if ('symbol' in body) updateData.symbol = body.symbol
    if ('tokenType' in body) updateData.tokenType = body.tokenType
    if ('contractAddress' in body) updateData.contractAddress = body.contractAddress ?? null
    if ('logoUrl' in body) updateData.logoUrl = body.logoUrl ?? null
    if ('priceSymbol' in body) updateData.priceSymbol = body.priceSymbol
    if ('minAmount' in body) updateData.minAmount = Number(body.minAmount)
    if ('maxUsdValue' in body) updateData.maxUsdValue = Number(body.maxUsdValue)
    if ('presetAmounts' in body) updateData.presetAmounts = body.presetAmounts
    if ('isActive' in body) updateData.isActive = body.isActive
    if ('displayOrder' in body) updateData.displayOrder = Number(body.displayOrder) || 0

    const updated = await db.gasTokenConfig.update({ where: { id }, data: updateData })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_UPDATED', 'GasTokenConfig', id, updateData)
    return reply.send({ success: true, data: updated })
  })

  // DELETE /admin/gas/tokens/:id — delete token (only if no orders reference it)
  app.delete('/admin/gas/tokens/:id', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const token = await db.gasTokenConfig.findUnique({ where: { id } })
    if (!token) throw Errors.NOT_FOUND('Gas token config')

    const orderCount = await db.gasFeeOrder.count({ where: { gasTokenConfigId: id } })
    if (orderCount > 0) {
      throw new AppError('CONFLICT', `Cannot delete token — ${orderCount} orders reference it`, 409)
    }

    await db.gasTokenConfig.delete({ where: { id } })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_DELETED', 'GasTokenConfig', id, { symbol: token.symbol })
    return reply.send({ success: true })
  })

  // ── POST /admin/gas/orders/:id/approve-pkr — approve a payment_uploaded PKR order ──

  app.post('/admin/gas/orders/:id/approve-pkr', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    // Read first so we can check expiry before queuing delivery
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    if (order.status !== 'payment_uploaded' || order.paymentCoin !== 'PKR') {
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only approve payment_uploaded PKR orders`, 409)
    }

    if (order.expiresAt < new Date()) {
      throw new AppError('ORDER_EXPIRED', 'Order has expired. The user must create a new order.', 409)
    }

    // CAS: transition payment_uploaded → payment_detected (guards against race with another admin)
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: 'payment_uploaded', paymentCoin: 'PKR' },
      data:  { status: 'payment_detected' },
    })
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'Order was already processed by another admin', 409)
    }
    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_PKR_APPROVED', 'GasFeeOrder', id, {})
    return reply.send({ success: true, data: { status: 'payment_detected' } })
  })

  // ── POST /admin/gas/orders/:id/reject-pkr — reject a payment_uploaded PKR order ────

  app.post('/admin/gas/orders/:id/reject-pkr', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { reason?: string }
    const reason = body?.reason ?? 'PKR payment rejected by admin'
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: 'payment_uploaded', paymentCoin: 'PKR' },
      data:  { status: 'failed', failureReason: reason },
    })
    if (claimed.count === 0) {
      const order = await db.gasFeeOrder.findUnique({ where: { id } })
      if (!order) throw Errors.NOT_FOUND('Gas fee order')
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only reject payment_uploaded PKR orders`, 409)
    }
    await createAuditLog(req.user!.id, 'GAS_PKR_REJECTED', 'GasFeeOrder', id, { reason })
    return reply.send({ success: true, data: { status: 'failed' } })
  })

  // ── GET /admin/gas/custom-requests — list custom gas fee requests ─────────────────

  app.get('/admin/gas/custom-requests', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { z } = await import('zod')
    const qSchema = z.object({
      page:   z.coerce.number().int().positive().default(1),
      limit:  z.coerce.number().int().min(1).max(50).default(20),
      status: z.enum(['pending', 'reviewing', 'completed', 'rejected']).optional(),
    })
    const { page, limit, status } = qSchema.parse(req.query)
    const skip = (page - 1) * limit
    const where = status ? { status } : {}
    const [requests, total] = await Promise.all([
      db.gasCustomRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.gasCustomRequest.count({ where }),
    ])
    return reply.send({ success: true, data: { requests, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } })
  })

  // ── PATCH /admin/gas/custom-requests/:id — update status/notes ───────────────────

  app.patch('/admin/gas/custom-requests/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      status:     z.enum(['pending', 'reviewing', 'completed', 'rejected']).optional(),
      adminNotes: z.string().max(1000).optional(),
    })
    const { id } = req.params as { id: string }
    const body = schema.parse(req.body)
    const existing = await db.gasCustomRequest.findUnique({ where: { id } })
    if (!existing) throw Errors.NOT_FOUND('Gas custom request')
    // Build update payload explicitly — exactOptionalPropertyTypes requires no undefined values on the data object
    const updated = await db.gasCustomRequest.update({
      where: { id },
      data: {
        ...(body.status     !== undefined ? { status:     body.status     } : {}),
        ...(body.adminNotes !== undefined ? { adminNotes: body.adminNotes } : {}),
      },
    })
    await createAuditLog(req.user!.id, 'GAS_CUSTOM_REQUEST_UPDATED', 'GasCustomRequest', id, body)
    return reply.send({ success: true, data: updated })
  })

  // ── POST /admin/gas/wallets/:chain/test-rpc — validate RPC + signer + address ──

  app.post('/admin/gas/wallets/:chain/test-rpc', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { getEvmHotWalletAddress, getTronHotWalletAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')

    const wallet = await db.gasHotWallet.findFirst({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' | 'AVAX' | 'OP' | 'SUI', hdIndex: 0 },
    })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    const chainId = fromDbChain(chain)
    const chainConfig = GAS_CHAINS[chainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `RPC test not supported for ${chain}`, 400)

    // 1. RPC reachability + latest block
    const rpcResult = await testRpcHealth(chainId)

    // 2. Signer / address derivation check
    let signerOk = false
    let derivedAddress: string | null = null
    let signerError: string | undefined
    try {
      if (chain === 'TRON') {
        derivedAddress = getTronHotWalletAddress()
      } else if (chain === 'SOL') {
        derivedAddress = getSolanaHotWalletAddress()
      } else if (chain === 'TON') {
        derivedAddress = getTonHotWalletAddress()
      } else if (chain === 'SUI') {
        derivedAddress = getSuiHotWalletAddress()
      } else {
        // All EVM chains share the same hot wallet address
        derivedAddress = getEvmHotWalletAddress()
      }
      signerOk = !!derivedAddress
      if (!signerOk) signerError = 'Mnemonic system not configured (GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT missing)'
    } catch (err) {
      signerError = err instanceof Error ? err.message : String(err)
    }

    // 3. Address match check (derived vs DB)
    const addressMatch = derivedAddress
      ? derivedAddress.toLowerCase() === wallet.address.toLowerCase()
      : null

    await createAuditLog(req.user!.id, 'GAS_RPC_TESTED', 'GasHotWallet', wallet.id, {
      chain, rpcOk: rpcResult.reachable, signerOk, addressMatch,
    })

    return reply.send({
      success: true,
      data: {
        chain,
        rpc: {
          reachable:   rpcResult.reachable,
          blockNumber: rpcResult.blockNumber ?? null,
          latencyMs:   rpcResult.latencyMs,
          isStale:     rpcResult.isStale ?? false,
          error:       rpcResult.error ?? null,
        },
        signer: {
          ok:           signerOk,
          derivedAddress,
          walletAddress: wallet.address,
          addressMatch,
          error:        signerError ?? null,
        },
        allClear: rpcResult.reachable && signerOk && addressMatch !== false,
      },
    })
  })

  // ── GET /admin/gas/global-pause — read the global pause switch ────────────────

  app.get('/admin/gas/global-pause', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const row = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
    const paused = row?.value === '1'
    const reason = paused ? (await db.platformConfig.findUnique({ where: { key: 'gas_global_pause_reason' } }))?.value ?? null : null
    return reply.send({ success: true, data: { paused, reason } })
  })

  // ── POST /admin/gas/global-pause — set or clear the global pause (super_admin) ─

  app.post('/admin/gas/global-pause', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { paused, reason } = req.body as { paused: boolean; reason?: string }
    if (typeof paused !== 'boolean') throw new AppError('VALIDATION_ERROR', 'paused must be a boolean', 400)

    await db.platformConfig.upsert({
      where:  { key: 'gas_global_pause' },
      create: { key: 'gas_global_pause', value: paused ? '1' : '0' },
      update: { value: paused ? '1' : '0' },
    })
    if (paused && reason) {
      await db.platformConfig.upsert({
        where:  { key: 'gas_global_pause_reason' },
        create: { key: 'gas_global_pause_reason', value: reason },
        update: { value: reason },
      })
    } else if (!paused) {
      await db.platformConfig.deleteMany({ where: { key: 'gas_global_pause_reason' } })
    }

    await createAuditLog(req.user!.id, paused ? 'GAS_GLOBAL_PAUSED' : 'GAS_GLOBAL_RESUMED', 'PlatformConfig', 'gas_global_pause', {
      paused, reason: reason ?? null,
    })

    return reply.send({ success: true, data: { paused, reason: reason ?? null } })
  })

  // ── GET /admin/gas/system-health — comprehensive production health check ───────
  //
  // Returns a single payload covering every aspect of the gas fee system:
  //   - RPC connectivity for all configured chains
  //   - Hot wallet balances + status
  //   - Queue health (BullMQ)
  //   - Redis connectivity
  //   - Mnemonic system status
  //   - Global pause state
  //   - Stale rate warnings
  //   - Chain readiness matrix
  //   - Delivery health per chain

  app.get('/admin/gas/system-health', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain, SUPPORTED_GAS_CHAINS } = await import('../lib/gas/gas.chains')
    const { testRpcHealth, getNativeUsdPrice } = await import('../lib/gas/gas.balance')
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress, getEffectiveDepositAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')
    const { CHAIN_READINESS_MATRIX, UNSUPPORTED_FEATURES, getChainCapabilities, buildChainReadinessReport } = await import('../lib/gas/chainMeta')
    const { getUsdtContractAddress }    = await import('../lib/gas/gas.refund')
    const { getAllChainRpcFallbackStatus } = await import('../lib/gas/rpcFallback')
    const { env: envVars }              = await import('../lib/env')

    // ── 1. Redis health ────────────────────────────────────────────────────────
    let redisOk = false
    let redisError: string | undefined
    try {
      await redisClient.ping()
      redisOk = true
    } catch (err) {
      redisError = err instanceof Error ? err.message : String(err)
    }

    // ── 2. Mnemonic system ────────────────────────────────────────────────────
    const mnemonicConfigured = gasWalletIsConfigured()
    const mnemonicAddresses = mnemonicConfigured ? {
      tron: getTronHotWalletAddress(),
      evm:  getEvmHotWalletAddress(),
      sol:  getSolanaHotWalletAddress(),
      ton:  getTonHotWalletAddress(),
      sui:  getSuiHotWalletAddress(),
    } : null

    // ── 3. Global pause ───────────────────────────────────────────────────────
    const globalPauseRow = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
    const globallyPaused = globalPauseRow?.value === '1'

    // ── 4. Hot wallets from DB ────────────────────────────────────────────────
    const wallets = await db.gasHotWallet.findMany({ where: { isActive: true } })
    const chainConfigs = await db.gasChainConfig.findMany({
      select: { slug: true, backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true, readinessState: true, isActive: true },
    })
    const chainConfigMap = Object.fromEntries(chainConfigs.map((c) => [c.slug, c]))

    // ── 5. RPC health for all supported chains (parallel, best-effort) ────────
    const rpcResults = await Promise.allSettled(
      SUPPORTED_GAS_CHAINS.map(async (chainId) => {
        const rpc = await testRpcHealth(chainId)
        const pausedKey = `gas_wallet_paused:${chainId === 'ETHEREUM' ? 'ETH' : chainId}`
        const isPaused = !!(await redisClient.get(pausedKey))
        return { chainId, rpc, isPaused }
      })
    )

    const rpcMap: Record<string, { reachable: boolean; latencyMs: number; isStale?: boolean; blockNumber?: number; error?: string; isPaused: boolean }> = {}
    for (const r of rpcResults) {
      if (r.status === 'fulfilled') {
        const { chainId, rpc, isPaused } = r.value
        rpcMap[chainId] = {
          reachable: rpc.reachable,
          latencyMs: rpc.latencyMs,
          ...(rpc.isStale !== undefined ? { isStale: rpc.isStale } : {}),
          ...(rpc.blockNumber !== undefined ? { blockNumber: rpc.blockNumber } : {}),
          ...(rpc.error !== undefined ? { error: rpc.error } : {}),
          isPaused,
        }
      }
    }

    // ── 6. Wallet health (cached balances) ────────────────────────────────────
    const walletHealth = await Promise.all(
      wallets.map(async (w) => {
        const chainId = fromDbChain(w.chain)
        const dbChain = w.chain as string
        const balanceKey    = `gas_wallet_balance:${dbChain}`
        const balanceUsdKey = `gas_wallet_balance_usd:${dbChain}`
        const pausedKey     = `gas_wallet_paused:${dbChain}`
        const [balStr, balUsdStr, pausedStr] = await Promise.all([
          redisClient.get(balanceKey),
          redisClient.get(balanceUsdKey),
          redisClient.get(pausedKey),
        ])
        const balance    = balStr    ? parseFloat(balStr)    : null
        const balanceUsd = balUsdStr ? parseFloat(balUsdStr) : null
        const isPaused   = !!pausedStr
        const cfg = GAS_CHAINS[chainId]
        const chainCfg = chainConfigMap[dbChain === 'ETH' ? 'ETH' : dbChain]
        const usdPrice = await getNativeUsdPrice(chainId).catch(() => 0)
        const alertThresholdUsd = chainCfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = chainCfg?.pauseThresholdUsd ?? null
        let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'unavailable'
        if (balanceUsd !== null) {
          if (isPaused || (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd)) status = 'paused'
          else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'
          else status = 'healthy'
        }
        return {
          chain: dbChain,
          chainId,
          address: w.address,
          nativeSymbol: cfg?.nativeSymbol ?? dbChain,
          balance,
          balanceUsd,
          usdPrice,
          isPaused,
          status,
          alertThresholdUsd,
          pauseThresholdUsd,
          lastRefreshedAt: w.lastBalanceRefreshAt?.toISOString() ?? null,
        }
      })
    )

    // ── 7. Stale rate detection ───────────────────────────────────────────────
    const rateSymbols = ['TRX', 'BNB', 'ETH', 'MATIC', 'AVAX', 'SOL', 'TON', 'SUI']
    const rateChecks = await Promise.all(
      rateSymbols.map(async (sym) => {
        const v = await redisClient.get(`rate:${sym}`)
        return { symbol: sym, hasRate: !!v }
      })
    )
    const staleRates = rateChecks.filter((r) => !r.hasRate).map((r) => r.symbol)

    // ── 8. BullMQ queue health ────────────────────────────────────────────────
    let queueHealth: Array<{ name: string; waiting: number; active: number; failed: number }> = []
    try {
      const { queues } = await import('../queues/definitions')
      const queueEntries = Object.entries(queues)
      queueHealth = await Promise.all(
        queueEntries.map(async ([name, q]) => {
          const [waiting, active, failed] = await Promise.all([
            q.getWaitingCount().catch(() => -1),
            q.getActiveCount().catch(() => -1),
            q.getFailedCount().catch(() => -1),
          ])
          return { name, waiting, active, failed }
        })
      )
    } catch {
      // Queue health is best-effort — don't fail the endpoint
    }

    // ── 9. Delivery health per chain ──────────────────────────────────────────
    const [pendingDeliveries, failedDeliveries] = await Promise.all([
      db.gasFeeOrder.groupBy({
        by: ['chain', 'status'],
        where: { status: { in: ['payment_detected', 'sending'] } },
        _count: { status: true },
      }),
      db.gasFeeOrder.groupBy({
        by: ['chain'],
        where: { status: 'failed', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
        _count: { status: true },
      }),
    ])

    const deliveryHealth: Record<string, { pending: number; failed24h: number }> = {}
    for (const r of pendingDeliveries) deliveryHealth[r.chain as string] = { pending: r._count.status, failed24h: 0 }
    for (const r of failedDeliveries) {
      const key = r.chain as string
      if (!deliveryHealth[key]) deliveryHealth[key] = { pending: 0, failed24h: 0 }
      deliveryHealth[key]!.failed24h = r._count.status
    }

    // ── 10. Chain readiness state ─────────────────────────────────────────────
    const chainReadiness = chainConfigs.map((c) => ({
      slug:          c.slug,
      readinessState: c.readinessState,
      isActive:      c.isActive,
      hasBackend:    !!c.backendChainId,
      capabilities:  getChainCapabilities(c.slug),
      rpc:           rpcMap[c.backendChainId === 'ETH' ? 'ETHEREUM' : (c.backendChainId ?? c.slug)] ?? null,
    }))

    // ── 11. RPC fallback status (parallel probe of all EVM chain fallback lists) ─
    const evmRpcUrls: Partial<Record<string, string>> = {
      ETHEREUM: envVars.ETHEREUM_RPC_URL,
      BSC:      envVars.BSC_RPC_URL,
      BASE:     envVars.BASE_RPC_URL,
      ARB:      envVars.ARBITRUM_RPC_URL,
      OP:       envVars.OPTIMISM_RPC_URL,
      MATIC:    envVars.POLYGON_RPC_URL,
      AVAX:     envVars.AVALANCHE_RPC_URL,
    }
    const rpcFallbackStatus = await getAllChainRpcFallbackStatus(
      evmRpcUrls as Parameters<typeof getAllChainRpcFallbackStatus>[0]
    ).catch(() => [])

    // ── 12. Per-chain deposit + refund + confirmation readiness ────────────────
    // Covers all EVM chains + TRON. SOL/TON/SUI remain inactive.
    const chainDepositRefundReadiness = (() => {
      const evmDepositAddr = getEffectiveDepositAddress('EVM', envVars.GAS_FEE_DEPOSIT_ADDRESS_ERC20 ?? undefined)
      const tronDepositAddr = getEffectiveDepositAddress('TRON', envVars.GAS_FEE_DEPOSIT_ADDRESS_TRC20 ?? undefined)

      const chainEnvDepositMap: Record<string, string | undefined> = {
        TRON:     envVars.GAS_FEE_DEPOSIT_ADDRESS_TRC20,
        BSC:      envVars.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
        ETHEREUM: envVars.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
        BASE:     envVars.GAS_FEE_DEPOSIT_ADDRESS_BASE,
        ARB:      envVars.GAS_FEE_DEPOSIT_ADDRESS_ARB,
        OP:       envVars.GAS_FEE_DEPOSIT_ADDRESS_OP,
        MATIC:    envVars.GAS_FEE_DEPOSIT_ADDRESS_MATIC,
        AVAX:     envVars.GAS_FEE_DEPOSIT_ADDRESS_AVAX,
      }

      return Object.entries(chainEnvDepositMap).map(([chain, envAddr]) => {
        const backendChainKey = chain === 'ETHEREUM' ? 'ETHEREUM' : chain
        const rpcStatus = rpcMap[backendChainKey]
        const depositAddr = envAddr ?? (chain === 'TRON' ? tronDepositAddr.address : evmDepositAddr.address)
        const depositSource = envAddr
          ? ('env_var' as const)
          : (chain === 'TRON' ? tronDepositAddr.source : evmDepositAddr.source)

        return buildChainReadinessReport(chain, {
          depositAddress:     depositAddr ?? null,
          depositSource,
          usdtContract:       getUsdtContractAddress(chain as import('../lib/gas/gas.chains').GasChainId),
          mnemonicConfigured,
          rpcReachable:       rpcStatus?.reachable ?? false,
        })
      })
    })()

    // ── Final assembly ────────────────────────────────────────────────────────
    const criticalIssues: string[] = []
    if (!redisOk) criticalIssues.push('Redis unreachable')
    if (globallyPaused) criticalIssues.push('Gas system globally paused')
    if (!mnemonicConfigured) criticalIssues.push('Gas mnemonic not configured — delivery requires mnemonic')
    for (const w of walletHealth) {
      if (w.status === 'paused') criticalIssues.push(`${w.chain} wallet auto-paused (below pause threshold)`)
    }
    for (const [chainId, rpc] of Object.entries(rpcMap)) {
      if (!rpc.reachable) criticalIssues.push(`${chainId} RPC unreachable: ${rpc.error}`)
    }
    for (const report of chainDepositRefundReadiness) {
      if (!report.depositReady) {
        criticalIssues.push(`${report.chain} deposit address not configured`)
      }
    }

    return reply.send({
      success: true,
      data: {
        generatedAt:       new Date().toISOString(),
        overallHealthy:    criticalIssues.length === 0,
        criticalIssues,
        redis: { ok: redisOk, error: redisError ?? null },
        mnemonic: {
          configured: mnemonicConfigured,
          addresses:  mnemonicAddresses,
        },
        globallyPaused,
        rpc:                rpcMap,
        rpcFallbackStatus,
        walletHealth,
        staleRates,
        queueHealth,
        deliveryHealth,
        chainReadiness,
        chainDepositRefundReadiness,
        readinessMatrix:    CHAIN_READINESS_MATRIX,
        unsupportedFeatures: UNSUPPORTED_FEATURES,
      },
    })
  })

  // ── POST /admin/gas/chains/:chain/dry-run — pre-flight delivery check ─────────

  app.post('/admin/gas/chains/:chain/dry-run', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const body = req.body as { toAddress?: string; amount?: number }
    const toAddress = body.toAddress ?? ''
    const amount    = typeof body.amount === 'number' ? body.amount : 0.001

    const { dryRunDelivery } = await import('../lib/gas/gas.delivery')
    const result = await dryRunDelivery(chain, toAddress, amount)

    void createAuditLog(req.user!.id, 'GAS_DRY_RUN', 'GasChain', chain, { toAddress, amount, result })

    return reply.send({ success: true, data: result })
  })

  // ── GET /admin/gas/analytics — delivery analytics ─────────────────────────────

  app.get('/admin/gas/analytics', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { period = '7d' } = req.query as { period?: '24h' | '7d' | '30d' | 'all' }

    const since = period === 'all' ? undefined
      : new Date(Date.now() - (
          period === '24h' ? 86_400_000
          : period === '7d' ? 7 * 86_400_000
          : 30 * 86_400_000
        ))

    const where = since ? { createdAt: { gte: since } } : {}

    const [deliveredOrders, failedCount, chainGroups] = await Promise.all([
      db.gasFeeOrder.findMany({
        where:  { ...where, status: 'delivered', deliveredAt: { not: null } },
        select: { chain: true, createdAt: true, deliveredAt: true },
      }),
      db.gasFeeOrder.count({ where: { ...where, status: 'failed' } }),
      db.gasFeeOrder.groupBy({
        by: ['chain', 'status'],
        where,
        _count: { status: true },
      }),
    ])

    const successCount = deliveredOrders.length

    // Average completion time (ms → seconds)
    let avgCompletionSec: number | null = null
    if (successCount > 0) {
      const totalMs = deliveredOrders.reduce((sum, o) => {
        return sum + (o.deliveredAt!.getTime() - o.createdAt.getTime())
      }, 0)
      avgCompletionSec = Math.round(totalMs / successCount / 1000)
    }

    // Per-chain success rates
    const chainMap: Record<string, { delivered: number; failed: number }> = {}
    for (const g of chainGroups) {
      const c = g.chain as string
      if (!chainMap[c]) chainMap[c] = { delivered: 0, failed: 0 }
      if (g.status === 'delivered') chainMap[c]!.delivered += g._count.status
      if (g.status === 'failed')    chainMap[c]!.failed    += g._count.status
    }
    const chainStats = Object.entries(chainMap).map(([chain, s]) => ({
      chain,
      delivered: s.delivered,
      failed:    s.failed,
      total:     s.delivered + s.failed,
      successRate: s.delivered + s.failed > 0
        ? Math.round((s.delivered / (s.delivered + s.failed)) * 100)
        : null,
    }))

    return reply.send({
      success: true,
      data: {
        period,
        successCount,
        failedCount,
        avgCompletionSec,
        chainStats,
      },
    })
  })

  // ── Treasury Wallet ────────────────────────────────────────────────────────

  // GET /admin/gas/treasury — list treasury wallets with live balances
  app.get('/admin/gas/treasury', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const addrs = getAllTreasuryAddresses()

    const [tronRow, evmRow] = await Promise.all([
      db.gasTreasuryWallet.findUnique({ where: { chain: 'TRON' } }),
      db.gasTreasuryWallet.findUnique({ where: { chain: 'ETH'  } }),
    ])

    const results = await Promise.allSettled([
      addrs.tron ? getTreasuryBalance('TRON')     : Promise.resolve(null),
      addrs.evm  ? getTreasuryBalance('ETHEREUM')  : Promise.resolve(null),
    ])

    return reply.send({
      success: true,
      data: {
        tron: {
          address:        addrs.tron,
          derivationIndex: 100,
          dbRow:           tronRow,
          balance:         results[0].status === 'fulfilled' ? results[0].value : null,
          balanceError:    results[0].status === 'rejected'  ? String(results[0].reason) : null,
        },
        evm: {
          address:         addrs.evm,
          derivationIndex: 101,
          dbRow:           evmRow,
          balance:         results[1].status === 'fulfilled' ? results[1].value : null,
          balanceError:    results[1].status === 'rejected'  ? String(results[1].reason) : null,
          note:            'One EVM address serves ETH, BSC, Base, ARB, OP, Polygon, Avalanche',
        },
      },
    })
  })

  // POST /admin/gas/treasury/seed — create GasTreasuryWallet DB rows from derived addresses
  app.post('/admin/gas/treasury/seed', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const tronAddr = getTronTreasuryAddress()
    const evmAddr  = getEvmTreasuryAddress()

    if (!tronAddr || !evmAddr) {
      return reply.status(503).send({ success: false, error: 'Gas wallet mnemonic not configured' })
    }

    const [tronRow, evmRow] = await Promise.all([
      db.gasTreasuryWallet.upsert({
        where: { chain: 'TRON' },
        create: { chain: 'TRON', chainFamily: 'TRON', address: tronAddr, derivationIndex: 100 },
        update: { address: tronAddr, isActive: true },
      }),
      db.gasTreasuryWallet.upsert({
        where: { chain: 'ETH' },
        create: { chain: 'ETH', chainFamily: 'EVM', address: evmAddr, derivationIndex: 101 },
        update: { address: evmAddr, isActive: true },
      }),
    ])

    await createAuditLog(
      (req.user as { id: string }).id,
      'gas_treasury_seed',
      'GasTreasuryWallet',
      'all',
      { tronAddress: tronAddr, evmAddress: evmAddr },
    )

    return reply.send({ success: true, data: { tron: tronRow, evm: evmRow } })
  })

  // ── Accounting Ledger ──────────────────────────────────────────────────────

  // GET /admin/gas/ledger — paginated ledger entries
  app.get('/admin/gas/ledger', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit } = paginationParams(q)

    const result = await getLedgerEntries({
      page,
      limit,
      ...(q.chain     ? { chain:          q.chain     as GasChainId }                          : {}),
      ...(q.entryType ? { entryType:      q.entryType as import('@prisma/client').GasLedgerEntryType } : {}),
      ...(q.orderId   ? { relatedOrderId: q.orderId }                                           : {}),
      ...(q.from      ? { fromDate:       new Date(q.from) }                                    : {}),
      ...(q.to        ? { toDate:         new Date(q.to)   }                                    : {}),
    })

    return reply.send({ success: true, data: result })
  })

  // GET /admin/gas/ledger/summary — aggregated P&L per chain
  app.get('/admin/gas/ledger/summary', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.query as { chain?: string }
    const summary = await getLedgerSummary(chain as GasChainId | undefined)
    return reply.send({ success: true, data: summary })
  })

  // ── Refill Thresholds ──────────────────────────────────────────────────────

  // GET /admin/gas/thresholds — list all per-chain refill thresholds
  app.get('/admin/gas/thresholds', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const thresholds = await getAllThresholds()
    return reply.send({ success: true, data: thresholds })
  })

  // GET /admin/gas/thresholds/:chain — single chain threshold
  app.get('/admin/gas/thresholds/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const threshold = await getThreshold(chain as GasChainId)
    if (!threshold) return reply.status(404).send({ success: false, error: 'Threshold not found' })
    return reply.send({ success: true, data: threshold })
  })

  // PUT /admin/gas/thresholds/:chain — create or update threshold
  app.put('/admin/gas/thresholds/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const body = req.body as {
      triggerBelowNative: number
      refillTargetNative: number
      maxRefillNative: number
      isEnabled?: boolean
    }

    const validationError = validateThreshold(body)
    if (validationError) {
      return reply.status(400).send({ success: false, error: validationError })
    }

    const threshold = await upsertThreshold(chain as GasChainId, body)

    await createAuditLog(
      (req.user as { id: string }).id,
      'gas_threshold_update',
      'GasRefillThreshold',
      chain,
      body as unknown as Record<string, unknown>,
    )

    return reply.send({ success: true, data: threshold })
  })

  // PATCH /admin/gas/thresholds/:chain/toggle — enable/disable
  app.patch('/admin/gas/thresholds/:chain/toggle', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { isEnabled } = req.body as { isEnabled: boolean }

    if (typeof isEnabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'isEnabled must be a boolean' })
    }

    const threshold = await setThresholdEnabled(chain as GasChainId, isEnabled)
    return reply.send({ success: true, data: threshold })
  })

  // ── Refill Requests ────────────────────────────────────────────────────────

  // GET /admin/gas/refills — list refill requests with filters
  app.get('/admin/gas/refills', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(q)

    const where: Prisma.GasRefillRequestWhereInput = {}
    if (q.chain)  where.chain  = q.chain  as import('@prisma/client').GasChain
    if (q.status) where.status = q.status as import('@prisma/client').GasRefillRequestStatus

    const [refills, total] = await Promise.all([
      db.gasRefillRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { fromWallet: true },
      }),
      db.gasRefillRequest.count({ where }),
    ])

    return reply.send({ success: true, data: { refills, total, page, limit } })
  })

  // GET /admin/gas/refills/:id — single refill request
  app.get('/admin/gas/refills/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const refill = await db.gasRefillRequest.findUnique({
      where: { id },
      include: { fromWallet: true, ledgerEntries: true },
    })
    if (!refill) return reply.status(404).send({ success: false, error: 'Refill request not found' })
    return reply.send({ success: true, data: refill })
  })

  // POST /admin/gas/refills/:id/approve — approve a pending refill
  app.post('/admin/gas/refills/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = (req.user as { id: string }).id

    try {
      await approveRefill(id, adminId)
      await createAuditLog(adminId, 'gas_refill_approved', 'GasRefillRequest', id, {})
      return reply.send({ success: true, message: 'Refill approved — will execute on next refill job run' })
    } catch (err) {
      return reply.status(400).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /admin/gas/refills/:id/cancel — cancel a pending or approved refill
  app.post('/admin/gas/refills/:id/cancel', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = (req.user as { id: string }).id

    try {
      await cancelRefill(id, adminId)
      await createAuditLog(adminId, 'gas_refill_cancelled', 'GasRefillRequest', id, {})
      return reply.send({ success: true, message: 'Refill cancelled' })
    } catch (err) {
      return reply.status(400).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /admin/gas/refills/trigger-check — manually trigger balance check + queue refills
  app.post('/admin/gas/refills/trigger-check', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const result = await checkAndQueueRefills()
    return reply.send({ success: true, data: result })
  })

  // POST /admin/gas/refills/process-approved — manually execute all approved refills
  app.post('/admin/gas/refills/process-approved', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const result = await processApprovedRefills()
    return reply.send({ success: true, data: result })
  })

  // GET /admin/gas/treasury/balances — hot vs treasury balance comparison per chain
  app.get('/admin/gas/treasury/balances', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const hotTron = getTronHotWalletAddress()
    const hotEvm  = getEvmHotWalletAddress()
    const trsTron = getTronTreasuryAddress()
    const trsEvm  = getEvmTreasuryAddress()

    const chains: Array<{ chain: GasChainId; hotAddress: string | null; treasuryAddress: string | null }> = [
      { chain: 'TRON',     hotAddress: hotTron, treasuryAddress: trsTron },
      { chain: 'BSC',      hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'ETHEREUM', hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'BASE',     hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'ARB',      hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'OP',       hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'MATIC',    hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'AVAX',     hotAddress: hotEvm,  treasuryAddress: trsEvm  },
    ]

    const balances = await Promise.allSettled(
      chains.map(async ({ chain, hotAddress, treasuryAddress }) => {
        const [hotBal, trsBal, usdPrice] = await Promise.allSettled([
          hotAddress      ? getHotWalletBalance(chain, hotAddress)     : Promise.resolve(null),
          treasuryAddress ? getTreasuryBalance(chain)                   : Promise.resolve(null),
          getNativeUsdPrice(chain),
        ])

        const hot   = hotBal.status === 'fulfilled' ? hotBal.value   : null
        const trs   = trsBal.status === 'fulfilled' ? trsBal.value   : null
        const price = usdPrice.status === 'fulfilled' ? usdPrice.value : 0

        return {
          chain,
          hotAddress,
          hotBalanceNative: hot,
          hotBalanceUsd:    hot != null && price > 0 ? hot * price : null,
          treasuryAddress,
          treasuryBalanceNative: trs,
          treasuryBalanceUsd:    trs != null && price > 0 ? trs * price : null,
          usdPrice: price,
        }
      }),
    )

    return reply.send({
      success: true,
      data: balances.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { chain: chains[i]!.chain, error: String(r.reason) },
      ),
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 4 — RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/reconciliation', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listReconciliationRuns(page, limit)
    return reply.send({ success: true, data: result })
  })

  app.get('/admin/gas/reconciliation/:runId', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const run = await getReconciliationRun(runId)
    if (!run) throw Errors.NOT_FOUND('Reconciliation run')
    return reply.send({ success: true, data: run })
  })

  app.post('/admin/gas/reconciliation/trigger', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = (req.body ?? {}) as { chain?: string }
    // Enqueue rather than run inline to avoid HTTP timeout on large datasets
    await queues.gasReconciliation.add('manual-trigger', { chain: chain ?? null }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_RECONCILIATION_TRIGGERED', 'GasReconciliation', 'manual', { chain: chain ?? 'all' })
    return reply.code(202).send({ success: true, data: { queued: true, message: `Reconciliation queued for ${chain ?? 'all chains'}` } })
  })

  app.patch('/admin/gas/reconciliation/discrepancies/:id/resolve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { adminNote } = (req.body ?? {}) as { adminNote?: string }
    const updated = await resolveDiscrepancy(id, req.user!.id, adminNote)
    await createAuditLog(req.user!.id, 'GAS_DISCREPANCY_RESOLVED', 'GasReconciliationDiscrepancy', id, { adminNote })
    return reply.send({ success: true, data: updated })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 5 — RISK / FRAUD FLAGGED ORDERS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/flagged', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit } = paginationParams(q)
    const status = q.status
    const result = await listFlaggedOrders(status, page, limit)
    return reply.send({ success: true, data: result })
  })

  app.patch('/admin/gas/flagged/:id/review', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { status: 'reviewed_ok' | 'reviewed_blocked'; adminNote?: string }
    if (!['reviewed_ok', 'reviewed_blocked'].includes(body.status)) {
      throw new AppError('VALIDATION_ERROR', 'status must be reviewed_ok or reviewed_blocked', 400)
    }
    const updated = await reviewFlaggedOrder(id, body.status, req.user!.id, body.adminNote)
    await createAuditLog(req.user!.id, 'GAS_FLAGGED_ORDER_REVIEWED', 'GasFlaggedOrder', id, { status: body.status, adminNote: body.adminNote })
    return reply.send({ success: true, data: updated })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 6 — MERCHANT SETTLEMENT
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/merchants', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listMerchantAccounts(page, limit)
    return reply.send({ success: true, data: result })
  })

  app.post('/admin/gas/merchants', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const body = req.body as { name: string; apiKeyId: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string }
    if (!body.name || !body.apiKeyId) throw new AppError('VALIDATION_ERROR', 'name and apiKeyId are required', 400)
    const apiKey = await db.merchantApiKey.findUnique({ where: { id: body.apiKeyId }, select: { id: true } })
    if (!apiKey) throw Errors.NOT_FOUND('Merchant API key')
    const account = await createMerchantAccount(body)
    await createAuditLog(req.user!.id, 'GAS_MERCHANT_ACCOUNT_CREATED', 'GasMerchantAccount', account.id, { name: body.name })
    return reply.code(201).send({ success: true, data: account })
  })

  app.get('/admin/gas/merchants/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const account = await getMerchantAccount(id)
    if (!account) throw Errors.NOT_FOUND('Merchant account')
    return reply.send({ success: true, data: account })
  })

  app.patch('/admin/gas/merchants/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { name?: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string | null; isActive?: boolean }
    const account = await updateMerchantAccount(id, body)
    await createAuditLog(req.user!.id, 'GAS_MERCHANT_ACCOUNT_UPDATED', 'GasMerchantAccount', id, body as Record<string, unknown>)
    return reply.send({ success: true, data: account })
  })

  app.get('/admin/gas/merchants/:id/settlements', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listMerchantSettlements(id, page, limit)
    return reply.send({ success: true, data: result })
  })

  app.post('/admin/gas/settlements/:id/approve', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { adminNote } = (req.body ?? {}) as { adminNote?: string }
    const settlement = await approveSettlement(id, req.user!.id, adminNote)
    await createAuditLog(req.user!.id, 'GAS_SETTLEMENT_APPROVED', 'GasMerchantSettlement', id, { adminNote })
    return reply.send({ success: true, data: settlement })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 7 — TREASURY ANALYTICS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/analytics/burn-rates', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { windowDays?: string; window?: string }
    const windowDays = parseInt(q.windowDays ?? q.window ?? '7', 10)
    const burnRates = await getChainBurnRates(windowDays)
    return reply.send({ success: true, data: { burnRates } })
  })

  app.get('/admin/gas/analytics/runways', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const runways = await getChainRunways()
    return reply.send({ success: true, data: { runways } })
  })

  app.get('/admin/gas/analytics/profitability', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string }
    const fromDate = from ? new Date(from) : undefined
    const toDate   = to   ? new Date(to)   : undefined
    const profitability = await getProfitabilityByChain(fromDate, toDate)
    return reply.send({ success: true, data: { profitability } })
  })

  app.get('/admin/gas/analytics/volume', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { chain?: string; windowDays?: string; window?: string }
    const windowDays = parseInt(q.windowDays ?? q.window ?? '30', 10)
    const raw = await getVolumeTimeSeries(q.chain as Parameters<typeof getVolumeTimeSeries>[0], windowDays)
    // Normalize field name: backend uses orderCount, expose as orders for the frontend
    const series = raw.map((d) => ({ date: d.date, orders: d.orderCount, revenueUsd: d.revenueUsd }))
    return reply.send({ success: true, data: { series } })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 8 — MULTI-HOT-WALLET MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/hot-wallets/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const wallets = await db.gasHotWallet.findMany({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI' },
      orderBy: { hdIndex: 'asc' },
    })
    const { redis: redisClient } = await import('../lib/redis')
    const withBalances = await Promise.all(
      wallets.map(async (w) => {
        const balStr    = await redisClient.get(`gas_wallet_balance:${chain}`)
        const balUsdStr = await redisClient.get(`gas_wallet_balance_usd:${chain}`)
        return {
          ...w,
          cachedBalanceNative: balStr    ? parseFloat(balStr)    : null,
          cachedBalanceUsd:    balUsdStr ? parseFloat(balUsdStr) : null,
        }
      }),
    )
    return reply.send({ success: true, data: { wallets: withBalances } })
  })

  app.post('/admin/gas/hot-wallets/:chain/add', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')

    if (!gasWalletIsConfigured()) {
      throw new AppError('CONFIG_ERROR', 'Gas mnemonic not configured', 503)
    }

    // Find next available hdIndex for this chain
    const existing = await db.gasHotWallet.findMany({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' | 'AVAX' | 'OP' | 'SUI' },
      orderBy: { hdIndex: 'desc' },
      take: 1,
    })
    const nextIndex = existing.length > 0 ? existing[0]!.hdIndex + 1 : 1

    // Derive address for new index — currently only index 0 is used for delivery;
    // additional wallets require manual funding before activation
    const address = chain === 'TRON' ? getTronHotWalletAddress(nextIndex) : getEvmHotWalletAddress(nextIndex)
    if (!address) throw new AppError('DERIVATION_ERROR', 'Could not derive address for new wallet', 500)

    const wallet = await db.gasHotWallet.create({
      data: {
        chain:    chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' | 'AVAX' | 'OP' | 'SUI',
        address,
        hdIndex:  nextIndex,
        weight:   0, // start with 0 weight until funded
        isActive: false,
      },
    })

    await createAuditLog(req.user!.id, 'GAS_HOT_WALLET_ADDED', 'GasHotWallet', wallet.id, { chain, hdIndex: nextIndex, address })
    return reply.code(201).send({ success: true, data: wallet })
  })

  app.patch('/admin/gas/hot-wallets/:id/toggle', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const wallet = await db.gasHotWallet.findUnique({ where: { id } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    // Prevent disabling the last active wallet for a chain — would block all deliveries
    if (wallet.isActive) {
      const activeCount = await db.gasHotWallet.count({ where: { chain: wallet.chain, isActive: true } })
      if (activeCount <= 1) {
        throw new AppError('VALIDATION_ERROR', `Cannot disable the last active wallet for ${wallet.chain}. Fund and activate another wallet first.`, 400)
      }
    }

    const updated = await db.gasHotWallet.update({ where: { id }, data: { isActive: !wallet.isActive } })
    await createAuditLog(req.user!.id, 'GAS_HOT_WALLET_TOGGLED', 'GasHotWallet', id, { chain: wallet.chain, hdIndex: wallet.hdIndex, isActive: updated.isActive })
    return reply.send({ success: true, data: { id: updated.id, isActive: updated.isActive } })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 9 — EMERGENCY / DISASTER RECOVERY ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/emergency/verify-derivation', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')

    if (!gasWalletIsConfigured()) throw new AppError('CONFIG_ERROR', 'Gas mnemonic not configured', 503)

    const dbWallets = await db.gasHotWallet.findMany({ orderBy: [{ chain: 'asc' }, { hdIndex: 'asc' }] })

    const report = dbWallets.map((w) => {
      let derivedAddress: string | undefined
      try {
        if (w.chain === 'TRON') derivedAddress = getTronHotWalletAddress(w.hdIndex) ?? undefined
        else if (w.chain === 'SOL') derivedAddress = getSolanaHotWalletAddress() ?? undefined
        else if (w.chain === 'TON') derivedAddress = getTonHotWalletAddress() ?? undefined
        else if (w.chain === 'SUI') derivedAddress = getSuiHotWalletAddress() ?? undefined
        else derivedAddress = getEvmHotWalletAddress(w.hdIndex) ?? undefined
      } catch { /* unsupported chain */ }

      const match = derivedAddress
        ? derivedAddress.toLowerCase() === w.address.toLowerCase()
        : null

      return { chain: w.chain, hdIndex: w.hdIndex, dbAddress: w.address, derivedAddress: derivedAddress ?? null, match }
    })

    const allMatch = report.every((r) => r.match !== false)
    return reply.send({ success: true, data: { allMatch, wallets: report } })
  })
}
