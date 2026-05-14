import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'
import { GAS_CHAINS, SUPPORTED_GAS_CHAINS, type GasChainId, toDbChain } from '../lib/gas/gas.chains'

const RATE_COIN: Record<GasChainId, string> = {
  TRON:     'TRX',
  BSC:      'BNB',
  ETHEREUM: 'ETH',
}

async function getNativeUsdRate(chain: GasChainId): Promise<number> {
  const coin = RATE_COIN[chain]
  const usdPkrStr = await redis.get('rate:USD_PKR')
  const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 0

  if (chain === 'TRON') {
    // TRX rate is stored as { rate: <PKR> } — derive USD via USD_PKR
    const trxJson = await redis.get('rate:TRX')
    const trxPkr = trxJson ? (JSON.parse(trxJson) as { rate: number }).rate : 0
    return trxPkr > 0 && usdPkrRate > 0 ? trxPkr / usdPkrRate : 0
  }

  // BNB / ETH: stored as { rate: <PKR> }
  const raw = await redis.get(`rate:${coin}`)
  const pkrRate = raw ? (JSON.parse(raw) as { rate: number }).rate : 0
  return pkrRate > 0 && usdPkrRate > 0 ? pkrRate / usdPkrRate : 0
}

const createOrderSchema = z.object({
  chain:          z.enum(['TRON', 'BSC', 'ETHEREUM']).default('TRON'),
  tier:           z.enum(['SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'JUMBO']),
  toAddress:      z.string().min(1),
  idempotencyKey: z.string().optional(),
})

export async function gasFeeRoutes(app: FastifyInstance) {
  // ── GET /api/gas-fee/prices — no auth ──────────────────────────────────────
  // Returns prices for TRON only (the active chain). When BSC/ETH are live,
  // clients should pass ?chain=BSC to get chain-specific pricing.

  app.get('/gas-fee/prices', async (req, reply) => {
    const chain = ((req.query as { chain?: string }).chain?.toUpperCase() as GasChainId | undefined) ?? 'TRON'
    const chainConfig = GAS_CHAINS[chain as GasChainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chain}' is not supported`, 400)

    const usdPkrStr = await redis.get('rate:USD_PKR')
    const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 280
    const nativeUsdRate = await getNativeUsdRate(chain as GasChainId)
    const nativePkrRate = nativeUsdRate * usdPkrRate
    const markup = chainConfig.getMarkupMultiplier()

    const rateStale = !(nativeUsdRate > 0)
    if (rateStale) {
      logger.warn({ chain }, 'rate missing/zero on /gas-fee/prices — is the rate-updater job running?')
    }

    const tiers = Object.entries(chainConfig.nativeTierAmounts).map(([name, nativeAmount]) => ({
      id:           name.toLowerCase(),
      name,
      nativeAmount,
      nativeSymbol: chainConfig.nativeSymbol,
      usdtPrice:    (nativeAmount * nativeUsdRate * markup).toFixed(2),
      pkrPrice:     (nativeAmount * nativePkrRate * markup).toFixed(0),
    }))

    return reply.send({
      success: true,
      data: {
        chain,
        tiers,
        nativePriceUsd: nativeUsdRate,
        rateStale,
        updatedAt: new Date().toISOString(),
      },
    })
  })

  // ── GET /api/gas-fee/chains — list supported chains + availability ─────────

  app.get('/gas-fee/chains', async (_req, reply) => {
    const chains = await Promise.all(
      SUPPORTED_GAS_CHAINS.map(async (chainId) => {
        const config = GAS_CHAINS[chainId]
        const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(chainId), isActive: true } })
        const isPaused = await redis.get(`gas_wallet_paused:${toDbChain(chainId)}`)
        const depositAddress = config.getDepositAddress()
        return {
          id:              chainId,
          name:            config.name,
          nativeSymbol:    config.nativeSymbol,
          networkLabel:    config.networkLabel,
          isAvailable:     !!(hotWallet && !isPaused && depositAddress),
        }
      }),
    )
    return reply.send({ success: true, data: { chains } })
  })

  // ── POST /api/gas-fee/orders — optionalAuth, guest allowed ─────────────────

  app.post('/gas-fee/orders', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { chain, tier, toAddress } = parsed.data
    const chainConfig = GAS_CHAINS[chain]

    // Idempotency key: prefer header, fall back to body field
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      parsed.data.idempotencyKey

    // 1. Address format validation (chain-specific)
    if (!chainConfig.validateAddress(toAddress)) {
      throw new AppError(
        'INVALID_ADDRESS',
        `Invalid ${chainConfig.networkLabel} address format`,
        400,
      )
    }

    // 2. Deposit address must be configured for this chain
    const depositAddress = chainConfig.getDepositAddress()
    if (!depositAddress) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chain} gas is not yet available.`, 400)
    }

    // 3. Hot wallet availability check
    const hotWallet = await db.gasHotWallet.findFirst({
      where: { chain: toDbChain(chain), isActive: true },
    })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${toDbChain(chain)}`)
    if (!hotWallet || isAutoPaused) {
      throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chain}. Please try again later.`, 503)
    }

    // 4. IP rate limit: 3 orders per clock-hour per IP
    const clientIp = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey = `gas_rl:${clientIp}:${clockHour}`
    const rlCount = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 3) {
      throw new AppError('RATE_LIMITED', 'Maximum 3 gas fee orders per hour per IP', 429)
    }

    // 5. Idempotency check (before any state mutation)
    if (idempotencyKey) {
      const idemRedisKey = `idem:gasfee:${idempotencyKey}`
      const existingId = await redis.get(idemRedisKey)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) {
          return reply.send({
            success: true,
            data: { ...existing, paymentAddress: depositAddress },
          })
        }
      }
    }

    // 6. Get native token USD rate
    const nativeUsdRate = await getNativeUsdRate(chain)
    if (!(nativeUsdRate > 0)) {
      logger.error({ chain }, 'native USD rate missing — cannot create gas order. Is the rate-updater job running?')
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    }
    const markup = chainConfig.getMarkupMultiplier()

    const gasAmountNative = chainConfig.nativeTierAmounts[tier]
    if (gasAmountNative === undefined) {
      throw new AppError('VALIDATION_ERROR', `Tier '${tier}' is not supported for chain ${chain}`, 400)
    }
    const gasAmountUSD    = gasAmountNative * nativeUsdRate
    const priceAtOrder    = nativeUsdRate
    const paymentAmount   = gasAmountUSD * markup

    // 7. Guest daily spend check (only unauthenticated users)
    const userId = req.user?.id ?? null
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      const currentSpend = parseFloat((await redis.get(spendKey)) ?? '0')
      if (currentSpend + paymentAmount > env.GAS_GUEST_DAILY_LIMIT_USD) {
        throw new AppError(
          'GUEST_LIMIT_EXCEEDED',
          `Guest orders are limited to $${env.GAS_GUEST_DAILY_LIMIT_USD} per day. Please create an account for higher limits.`,
          400,
        )
      }
    }

    // 8. Same-destination daily limit (guests: max 2 orders to the same address per day)
    if (!userId) {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const destCount = await db.gasFeeOrder.count({
        where: { toAddress, createdAt: { gte: todayStart } },
      })
      if (destCount >= 2) {
        throw new AppError(
          'DEST_LIMIT_EXCEEDED',
          'Maximum 2 gas orders to the same destination per day for guest users.',
          400,
        )
      }
    }

    // 9. Create order
    const orderRef  = generateOrderRef('GF')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        ...(userId ? { userId } : {}),
        ipAddress:      clientIp,
        chain:          toDbChain(chain),
        tier,
        gasAmountNative,
        gasAmountUSD,
        priceAtOrder,
        paymentCoin:    'USDT',
        paymentNetwork: chainConfig.networkLabel,
        paymentAmount,
        toAddress,
        fromHotWallet:  hotWallet.address,
        status:         'payment_pending',
        expiresAt,
      },
    })

    // 10. Enqueue per-order expiry job (5-min delay, idempotent jobId)
    await queues.gasFee.add(
      'expire-order',
      { orderId: order.id },
      { delay: 5 * 60 * 1000, jobId: `gas-expire-${order.id}` },
    )

    // 11. Update Redis: guest daily spend counter + idempotency key
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, paymentAmount)
      await redis.expire(spendKey, 86400)
    }

    if (idempotencyKey) {
      await redis.setex(`idem:gasfee:${idempotencyKey}`, 86400, order.id)
    }

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork:  order.paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    chainConfig.nativeSymbol,
        chain:           order.chain,
        expiresAt:       order.expiresAt.toISOString(),
      },
    })
  })

  // ── GET /api/gas-fee/orders/history — requires auth, paginated ───────────

  app.get('/gas-fee/orders/history', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const querySchema = z.object({
      page:  z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    const { page, limit } = querySchema.parse(req.query)
    const skip = (page - 1) * limit

    const [orders, total] = await Promise.all([
      db.gasFeeOrder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          orderRef:        true,
          chain:           true,
          tier:            true,
          gasAmountNative: true,
          paymentAmount:   true,
          paymentNetwork:  true,
          toAddress:       true,
          deliveryTxHash:  true,
          refundTxHash:    true,
          status:          true,
          createdAt:       true,
          deliveredAt:     true,
          refundedAt:      true,
        },
      }),
      db.gasFeeOrder.count({ where: { userId } }),
    ])

    return reply.send({
      success: true,
      data: {
        orders,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    })
  })

  // ── GET /api/gas-fee/orders/:orderRef — no auth ───────────────────────────

  app.get('/gas-fee/orders/:orderRef', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({ success: true, data: order })
  })

  // ── GET /api/gas-fee/orders/:orderRef/refund-status — no auth ─────────────

  app.get('/gas-fee/orders/:orderRef/refund-status', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef },
      select: { orderRef: true, status: true, refundedAt: true, failureReason: true },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({
      success: true,
      data: {
        orderRef:      order.orderRef,
        status:        order.status,
        isRefunded:    order.status === 'refunded',
        refundedAt:    order.refundedAt,
        failureReason: order.failureReason,
      },
    })
  })
}
