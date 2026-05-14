import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { optionalAuth } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'

const TRC20_ADDRESS_RE = /^T[A-Za-z1-9]{33}$/

const GAS_TIERS = {
  SMALL:  { trxAmount: 10 },
  MEDIUM: { trxAmount: 50 },
  LARGE:  { trxAmount: 100 },
} as const

type TierKey = keyof typeof GAS_TIERS

const createOrderSchema = z.object({
  chain:           z.string().default('TRON'),
  tier:            z.enum(['SMALL', 'MEDIUM', 'LARGE']),
  toAddress:       z.string().min(1),
  idempotencyKey:  z.string().optional(),
})

export async function gasFeeRoutes(app: FastifyInstance) {
  // ── GET /api/gas-fee/prices — no auth ──────────────────────────────────────

  app.get('/gas-fee/prices', async (_req, reply) => {
    const trxRateStr  = await redis.get('rate:TRX')
    const usdPkrStr   = await redis.get('rate:USD:PKR')
    const trxRate     = trxRateStr  ? parseFloat(trxRateStr)  : 0
    const usdPkrRate  = usdPkrStr   ? parseFloat(usdPkrStr)   : 280
    const markup      = env.GAS_MARKUP_MULTIPLIER_TRON

    const rateStale = !(trxRate > 0)
    if (rateStale) {
      logger.warn('rate:TRX missing or zero on /prices — returning stale flag. Is the rate-updater job running?')
    }

    const tiers = (Object.entries(GAS_TIERS) as [TierKey, { trxAmount: number }][]).map(
      ([name, { trxAmount }]) => ({
        id:        name.toLowerCase(),
        name,
        trxAmount,
        usdtPrice: (trxAmount * trxRate * markup).toFixed(2),
        pkrPrice:  (trxAmount * trxRate * markup * usdPkrRate).toFixed(0),
      }),
    )

    return reply.send({
      success: true,
      data: {
        tiers,
        trxPriceUsd: trxRate,
        rateStale,
        updatedAt: new Date().toISOString(),
      },
    })
  })

  // ── POST /api/gas-fee/orders — optionalAuth, guest allowed ─────────────────

  app.post('/gas-fee/orders', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { chain, tier, toAddress } = parsed.data

    // Idempotency key: prefer header, fall back to body field
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      parsed.data.idempotencyKey

    // 1. Chain validation — only TRON supported in Phase 1
    if (chain !== 'TRON') {
      throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chain}' is not yet supported. Only TRON is available.`, 400)
    }

    // 2. Address format validation
    if (!TRC20_ADDRESS_RE.test(toAddress)) {
      throw new AppError('INVALID_ADDRESS', 'Invalid TRC20 address format (must start with T, 34 characters)', 400)
    }

    // 3. Hot wallet availability check
    const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: 'TRON', isActive: true } })
    const isAutoPaused = await redis.get('gas_wallet_paused:TRON')
    if (!hotWallet || isAutoPaused) {
      throw new AppError('GAS_UNAVAILABLE', 'Gas is temporarily unavailable for TRON. Please try again later.', 503)
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
            data: {
              ...existing,
              paymentAddress: env.GAS_FEE_DEPOSIT_ADDRESS_TRC20 ?? '',
            },
          })
        }
      }
    }

    // 6. Get TRX rate + calculate amounts
    const trxRateStr = await redis.get('rate:TRX')
    const trxRate = trxRateStr ? parseFloat(trxRateStr) : 0
    if (!(trxRate > 0)) {
      logger.error('rate:TRX missing or zero — cannot create gas order. Is the rate-updater job running?')
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    }
    const markup = env.GAS_MARKUP_MULTIPLIER_TRON

    const gasAmountNative = GAS_TIERS[tier].trxAmount
    const gasAmountUSD    = gasAmountNative * trxRate
    const priceAtOrder    = trxRate
    const paymentAmount   = gasAmountUSD * markup

    // 7. Guest daily spend check (only unauthenticated users)
    const userId = req.user?.id ?? null
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD'
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
        ipAddress:        clientIp,
        chain:            'TRON',
        tier,
        gasAmountNative,
        gasAmountUSD,
        priceAtOrder,
        paymentCoin:      'USDT',
        paymentNetwork:   'TRC20',
        paymentAmount,
        toAddress,
        fromHotWallet:    hotWallet.address,
        status:           'payment_pending',
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
        orderRef:         order.orderRef,
        paymentAddress:   env.GAS_FEE_DEPOSIT_ADDRESS_TRC20 ?? '',
        paymentAmount:    order.paymentAmount.toString(),
        paymentNetwork:   order.paymentNetwork,
        gasAmountNative:  order.gasAmountNative.toString(),
        chain:            order.chain,
        expiresAt:        order.expiresAt.toISOString(),
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
        orderRef:     order.orderRef,
        status:       order.status,
        isRefunded:   order.status === 'refunded',
        refundedAt:   order.refundedAt,
        failureReason: order.failureReason,
      },
    })
  })
}
