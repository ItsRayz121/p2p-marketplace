import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireTotpIfEnabled } from '../middleware/auth.middleware'
import { createAdminNotif } from '../services/adminNotification.service'
import {
  getUserWallets,
  getDepositAddress,
  getLiveFee,
  getFeeSchedule,
  requestWithdrawal,
  getUserWithdrawals,
  confirmWithdrawal,
  cancelWithdrawalByToken,
  resendWithdrawalConfirmation,
  getTrustedAddresses,
  addTrustedAddress,
  removeTrustedAddress,
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
import { getAllChains, explorerTxUrl } from '../services/chainRegistry.service'

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
  type: z.enum(['jazzcash', 'easypaisa', 'sadapay', 'nayapay', 'bank_transfer']),
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

const trustedAddressSchema = z.object({
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const balances = (wallets as any[]).map((w) => ({
      coin: w.coin,
      network: w.network,
      available: (parseFloat(w.balance) - parseFloat(w.lockedBalance)).toFixed(8),
      locked: w.lockedBalance.toString(),
      total: w.balance.toString(),
    }))
    return reply.send({ success: true, data: { balances } })
  })

  // GET /api/wallet/balances/:coin
  app.get('/wallet/balances/:coin', { preHandler: [authenticate] }, async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const wallets = await getUserWallets(req.user!.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (wallets as any[]).find((x) => (x.coin as string).toLowerCase() === coin.toLowerCase())
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

  // GET /api/wallet/transactions — paginated transaction history.
  //
  // The Transaction model is linked to Wallet (walletId), not User directly.
  // We join through wallet: { userId } so Prisma resolves the relation
  // correctly. `coin` and `network` are promoted from the wallet join into the
  // response shape so the frontend can render them without a second request.
  app.get('/wallet/transactions', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const page = Math.max(parseInt(query.page ?? '1', 10), 1)
    const limit = Math.min(parseInt(query.limit ?? '20', 10), 50)

    const walletWhere: Record<string, unknown> = { userId }
    if (query.coin) walletWhere['coin'] = query.coin.toUpperCase()

    const txWhere: Record<string, unknown> = { wallet: walletWhere }
    if (query.type) txWhere['type'] = query.type

    const [rows, total] = await Promise.all([
      db.transaction.findMany({
        where: txWhere,
        include: { wallet: { select: { coin: true, network: true, userId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.transaction.count({ where: txWhere }),
    ])

    const transactions = rows.map(({ wallet: w, amount, fee, ...rest }) => ({
      ...rest,
      coin: w.coin,
      network: w.network,
      userId: w.userId,
      amount: amount.toString(),
      fee: fee.toString(),
    }))

    return reply.send({ success: true, data: { transactions, total, page, limit } })
  })

  // Tight per-user rate limit on deposit-address endpoints. Each lookup may
  // trigger HD derivation + a DB write, so we cap at 30 requests/minute keyed
  // off the authenticated user id (falls back to IP for unauthenticated
  // requests, which won't actually reach the handler given `authenticate`).
  const depositAddressRateLimit = {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      keyGenerator: (req: any) => `wallet-deposit:${req.user?.id ?? req.ip}`,
    },
  }

  // GET /api/wallet/deposits — the user's own recent on-chain deposits with
  // confirmation progress and explorer links. Backs the "Recent deposits"
  // widget on the wallet page so users can see the state of a transfer
  // between "I sent it" and "RupChain balance went up".
  app.get('/wallet/deposits', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const limit = Math.min(parseInt(query.limit ?? '20', 10), 50)

    const rows = await db.deposit.findMany({
      where: { userId },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    })

    const allChains = await getAllChains()
    const chainMap = new Map(allChains.map((c) => [c.id, c]))

    const data = await Promise.all(rows.map(async (r) => {
      const chain = chainMap.get(r.chain)
      const minConfirmations = chain?.minConfirmations ?? 0
      return {
        id: r.id,
        chain: r.chain,
        chainName: chain?.name ?? r.chain,
        symbol: r.symbol,
        amount: r.amount.toString(),
        confirmations: r.confirmations,
        minConfirmations,
        progress: minConfirmations > 0
          ? Math.min(1, r.confirmations / minConfirmations)
          : null,
        status: r.status,
        rejectionReason: r.rejectionReason,
        txHash: r.txHash,
        explorerUrl: await explorerTxUrl(r.chain, r.txHash),
        detectedAt: r.detectedAt,
        creditedAt: r.creditedAt,
      }
    }))

    return reply.send({ success: true, data: { deposits: data } })
  })

  // GET /api/wallet/deposit/:coin — simple alias using default network per coin
  app.get('/wallet/deposit/:coin', {
    preHandler: [authenticate],
    config: depositAddressRateLimit,
  }, async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const network = DEFAULT_NETWORKS[coin.toUpperCase()] ?? 'TRC20'
    const result = await getDepositAddress(req.user!.id, coin.toUpperCase(), network)
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/address/:coin/:network
  app.get('/wallet/address/:coin/:network', {
    preHandler: [authenticate],
    config: depositAddressRateLimit,
  }, async (req, reply) => {
    const { coin, network } = req.params as { coin: string; network: string }
    const result = await getDepositAddress(req.user!.id, coin.toUpperCase(), network.toUpperCase())
    return reply.send({ success: true, data: result })
  })

  // GET /api/wallet/chains — public catalogue of supported chains + tokens
  app.get('/wallet/chains', async (_req, reply) => {
    const allChains = await getAllChains()
    const chains = allChains.map((c) => ({
      id: c.id,
      chainId: c.chainId,
      name: c.name,
      family: c.family,
      nativeSymbol: c.nativeSymbol,
      networkLabel: c.networkLabel,
      minConfirmations: c.minConfirmations,
      tokens: c.tokens.map((t) => ({ symbol: t.symbol, decimals: t.decimals })),
    }))
    return reply.send({ success: true, data: { chains } })
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
  app.post('/wallet/withdraw', { preHandler: [authenticate, requireTotpIfEnabled] }, async (req, reply) => {
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
    // Only notify admins for manual-review withdrawals — Tier 1 auto-approved
    // ones send themselves and have their own failure alerts in withdrawal.sender.ts
    if (result.status !== 'auto_approved') {
      const userRow = await db.user.findUnique({ where: { id: userId }, select: { username: true } })
      const userLabel = userRow?.username ?? userId
      void createAdminNotif({
        category: 'SYSTEM',
        title:    'Withdrawal Requested',
        body:     `User ${userLabel} requested a withdrawal of ${parsed.data.amount} ${parsed.data.coin}`,
        href:     `/admin/withdrawals`,
        metadata: { userId, amount: parsed.data.amount, coin: parsed.data.coin },
      })
    }
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

  // POST /api/wallet/withdraw/confirm — user confirms from email link
  // Accepts either authenticated (user clicks while logged in) or token-only.
  // We identify the user from the withdrawal's userId, not the auth token,
  // so the confirm link works even if the session has been refreshed.
  app.post(
    '/wallet/withdraw/confirm',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (req) => {
            const body = req.body as { wid?: string }
            return body?.wid ? `wd-confirm:${body.wid}` : req.ip
          },
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>
      const { wid, token } = body
      if (!wid || !token) {
        throw new AppError('VALIDATION_ERROR', 'wid and token are required', 400)
      }
      // Load the withdrawal to get userId (no session required)
      const wd = await db.withdrawal.findUnique({
        where: { id: wid },
        select: { userId: true },
      })
      if (!wd) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404)

      const result = await confirmWithdrawal(wid, wd.userId, token)
      return reply.send({ success: true, data: result })
    },
  )

  // POST /api/wallet/withdraw/cancel — user cancels from email link
  app.post(
    '/wallet/withdraw/cancel',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (req) => {
            const body = req.body as { wid?: string }
            return body?.wid ? `wd-cancel:${body.wid}` : req.ip
          },
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>
      const { wid, cancelToken } = body
      if (!wid || !cancelToken) {
        throw new AppError('VALIDATION_ERROR', 'wid and cancelToken are required', 400)
      }
      const wd = await db.withdrawal.findUnique({
        where: { id: wid },
        select: { userId: true },
      })
      if (!wd) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404)

      const result = await cancelWithdrawalByToken(wid, wd.userId, cancelToken)
      return reply.send({ success: true, data: result })
    },
  )

  // POST /api/wallet/withdrawals/:id/resend-confirmation
  app.post(
    '/wallet/withdrawals/:id/resend-confirmation',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const result = await resendWithdrawalConfirmation(id, req.user!.id)
      return reply.send({ success: true, data: result })
    },
  )

  // GET /api/wallet/trusted-addresses
  app.get('/wallet/trusted-addresses', { preHandler: [authenticate] }, async (req, reply) => {
    const addresses = await getTrustedAddresses(req.user!.id)
    return reply.send({ success: true, data: addresses })
  })

  // POST /api/wallet/trusted-addresses
  app.post('/wallet/trusted-addresses', { preHandler: [authenticate, requireTotpIfEnabled] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = trustedAddressSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const address = await addTrustedAddress(userId, parsed.data)
    return reply.code(201).send({ success: true, data: address })
  })

  // DELETE /api/wallet/trusted-addresses/:id
  app.delete('/wallet/trusted-addresses/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    await removeTrustedAddress(userId, id)
    return reply.send({ success: true, message: 'Trusted address removed' })
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
