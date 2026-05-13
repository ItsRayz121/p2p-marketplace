import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import {
  getUserWallets,
  getDepositAddress,
  getLiveFee,
  getFeeSchedule,
  requestWithdrawal,
  getUserWithdrawals,
  lockCollateral,
  unlockCollateral,
  getCollateralStatus,
  getPaymentMethods,
  addPaymentMethod,
  deletePaymentMethod,
  getSavedAddresses,
  addSavedAddress,
  deleteSavedAddress,
} from '../services/wallet.service'
import { AppError } from '../lib/errors'
import { db } from '../lib/prisma'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const withdrawSchema = z.object({
  coin: z.string().min(1),
  network: z.string().min(1),
  amount: z.number().positive(),
  toAddress: z.string().min(1),
})

const lockCollateralSchema = z.object({
  coin: z.string().min(1),
  amount: z.number().positive(),
})

const paymentMethodSchema = z.object({
  type: z.enum(['jazzcash', 'easypaisa', 'bank_transfer']),
  displayName: z.string().min(1).max(100),
  accountName: z.string().min(1).max(100),
  mobileNumber: z.string().optional(),
  bankName: z.string().optional(),
  ibanNumber: z.string().optional(),
  accountNumber: z.string().optional(),
})

const savedAddressSchema = z.object({
  coin: z.string().min(1),
  network: z.string().min(1),
  address: z.string().min(1),
  label: z.string().min(1).max(100),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

const DEFAULT_NETWORKS: Record<string, string> = {
  USDT: 'TRC20', BTC: 'BTC', ETH: 'ERC20', BNB: 'BEP20', TRX: 'TRC20',
}

export async function walletRoutes(app: FastifyInstance) {
  // GET /api/wallet
  app.get('/wallet', { preHandler: [authenticate] }, async (req, reply) => {
    const wallets = await getUserWallets(req.user!.id)
    return reply.send({ success: true, data: wallets })
  })

  // GET /api/wallet/balances — frontend-friendly alias returning WalletBalance shape
  app.get('/wallet/balances', { preHandler: [authenticate] }, async (req, reply) => {
    const wallets = await getUserWallets(req.user!.id)
    const balances = wallets.map((w: any) => ({
      coin: w.coin,
      network: w.network,
      available: (parseFloat(w.balance) - parseFloat(w.lockedBalance)).toFixed(8),
      locked: w.lockedBalance,
      total: w.balance,
    }))
    return reply.send({ success: true, data: { balances } })
  })

  // GET /api/wallet/balances/:coin
  app.get('/wallet/balances/:coin', { preHandler: [authenticate] }, async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const wallets = await getUserWallets(req.user!.id)
    const w = wallets.find((x: any) => x.coin.toLowerCase() === coin.toLowerCase())
    if (!w) throw new AppError('NOT_FOUND', 'Wallet not found for this coin', 404)
    return reply.send({
      success: true,
      data: {
        coin: w.coin,
        network: w.network,
        available: (Number(w.balance) - Number(w.lockedBalance)).toFixed(8),
        locked: w.lockedBalance.toString(),
        total: w.balance.toString(),
      },
    })
  })

  // GET /api/wallet/transactions — paginated transaction history
  app.get('/wallet/transactions', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const page = Math.max(parseInt(query.page ?? '1', 10), 1)
    const limit = Math.min(parseInt(query.limit ?? '20', 10), 50)
    const where: any = { userId }
    if (query.coin) where.coin = query.coin.toUpperCase()
    if (query.type) where.type = query.type
    const [transactions, total] = await Promise.all([
      db.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.transaction.count({ where }),
    ])
    return reply.send({ success: true, data: { transactions, total, page, limit } })
  })

  // GET /api/wallet/deposit/:coin — simple alias using default network per coin
  app.get('/wallet/deposit/:coin', { preHandler: [authenticate] }, async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const network = DEFAULT_NETWORKS[coin.toUpperCase()] ?? 'TRC20'
    const result = await getDepositAddress(coin.toUpperCase(), network)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/address/:coin/:network
  app.get('/wallet/address/:coin/:network', { preHandler: [authenticate] }, async (req, reply) => {
    const { coin, network } = req.params as { coin: string; network: string }
    const result = await getDepositAddress(coin, network)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/live-fee?coin=USDT&network=TRC20
  app.get('/wallet/live-fee', { preHandler: [authenticate] }, async (req, reply) => {
    const query = req.query as { coin?: string; network?: string }
    if (!query.coin || !query.network) {
      throw new AppError('VALIDATION_ERROR', 'coin and network query params are required', 400)
    }
    const result = await getLiveFee(query.coin, query.network)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/fee-schedule — public
  app.get('/wallet/fee-schedule', async (_req, reply) => {
    const result = await getFeeSchedule()
    return reply.send({ success: true, data: result })
  })

  // POST /api/wallet/withdraw
  app.post('/wallet/withdraw', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const idempotencyKey = (req.headers['x-idempotency-key'] as string | undefined)?.trim()
    if (!idempotencyKey) {
      throw new AppError('VALIDATION_ERROR', 'X-Idempotency-Key header is required', 400)
    }

    const parsed = withdrawSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const result = await requestWithdrawal(userId, { ...parsed.data, idempotencyKey })
    return reply.code(201).send({ success: true, data: result })
  })

  // GET /api/wallet/withdrawals
  app.get('/wallet/withdrawals', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const result = await getUserWithdrawals(userId, {
      page: query.page ? parseInt(query.page, 10) : 1,
      limit: Math.min(query.limit ? parseInt(query.limit, 10) : 20, 50),
    })
    return reply.send({ success: true, data: result })
  })

  // POST /api/wallet/lock-collateral
  app.post('/wallet/lock-collateral', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = lockCollateralSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const lock = await lockCollateral(userId, parsed.data)
    return reply.code(201).send({ success: true, data: lock })
  })

  // POST /api/wallet/unlock-collateral/:lockId
  app.post('/wallet/unlock-collateral/:lockId', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { lockId } = req.params as { lockId: string }
    const result = await unlockCollateral(userId, lockId)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/collateral-status
  app.get('/wallet/collateral-status', { preHandler: [authenticate] }, async (req, reply) => {
    const result = await getCollateralStatus(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/payment-methods
  app.get('/wallet/payment-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const methods = await getPaymentMethods(req.user!.id)
    return reply.send({ success: true, data: methods })
  })

  // POST /api/wallet/payment-methods
  app.post('/wallet/payment-methods', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = paymentMethodSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const method = await addPaymentMethod(userId, parsed.data as any)
    return reply.code(201).send({ success: true, data: method })
  })

  // DELETE /api/wallet/payment-methods/:id
  app.delete('/wallet/payment-methods/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    await deletePaymentMethod(userId, id)
    return reply.send({ success: true, message: 'Payment method removed' })
  })

  // GET /api/wallet/saved-addresses
  app.get('/wallet/saved-addresses', { preHandler: [authenticate] }, async (req, reply) => {
    const addresses = await getSavedAddresses(req.user!.id)
    return reply.send({ success: true, data: addresses })
  })

  // POST /api/wallet/saved-addresses
  app.post('/wallet/saved-addresses', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = savedAddressSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const address = await addSavedAddress(userId, parsed.data)
    return reply.code(201).send({ success: true, data: address })
  })

  // DELETE /api/wallet/saved-addresses/:id
  app.delete('/wallet/saved-addresses/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    await deleteSavedAddress(userId, id)
    return reply.send({ success: true, message: 'Address removed' })
  })
}
