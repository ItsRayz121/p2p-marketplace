import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { optionalAuth } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { env } from '../lib/env'

const TRC20_ADDRESS_RE = /^T[A-Za-z1-9]{33}$/

const GAS_TIERS = {
  SMALL: { trxAmount: 10 },
  MEDIUM: { trxAmount: 50 },
  LARGE: { trxAmount: 100 },
} as const

const createOrderSchema = z.object({
  toAddress: z.string().regex(TRC20_ADDRESS_RE, 'Invalid TRC20 address format'),
  tier: z.enum(['SMALL', 'MEDIUM', 'LARGE']),
  idempotencyKey: z.string().optional(),
})

export async function gasFeeRoutes(app: FastifyInstance) {
  // GET /api/gas-fee/prices — no auth
  app.get('/gas-fee/prices', async (_req, reply) => {
    const trxRateStr = await redis.get('rate:TRX')
    const usdPkrStr = await redis.get('rate:USD:PKR')
    const trxRate = trxRateStr ? parseFloat(trxRateStr) : 0
    const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 280

    const tiers = Object.entries(GAS_TIERS).map(([tier, { trxAmount }]) => ({
      tier,
      trxAmount,
      pkrPrice: trxAmount * trxRate * usdPkrRate,
    }))

    return reply.send({
      success: true,
      data: {
        tiers,
        trxPriceUsd: trxRate,
        updatedAt: new Date().toISOString(),
      },
    })
  })

  // POST /api/gas-fee/orders — optionalAuth, guest allowed
  app.post('/gas-fee/orders', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { toAddress, tier, idempotencyKey } = parsed.data

    // IP rate limit: 5 per hour
    const clientIp = req.ip ?? 'unknown'
    const rateLimitKey = `gas_fee_rl:${clientIp}`
    const currentCount = await redis.incr(rateLimitKey)
    if (currentCount === 1) {
      await redis.expire(rateLimitKey, 3600)
    }
    if (currentCount > 5) {
      throw new AppError('RATE_LIMITED', 'Maximum 5 gas fee orders per hour per IP', 429)
    }

    // Idempotency check
    if (idempotencyKey) {
      const idemKey = `idem:gasfee:${idempotencyKey}`
      const existingId = await redis.get(idemKey)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: existing })
      }
    }

    // Get TRX rate
    const trxRateStr = await redis.get('rate:TRX')
    const trxRate = trxRateStr ? parseFloat(trxRateStr) : 0

    const gasAmountNative = GAS_TIERS[tier].trxAmount
    const gasAmountUSD = gasAmountNative * trxRate
    const priceAtOrder = trxRate
    // Payment amount in USDT (gas + markup)
    const markupMultiplier = env.GAS_MARKUP_MULTIPLIER_TRON ?? 1.5
    const paymentAmount = gasAmountUSD * markupMultiplier

    const orderRef = generateOrderRef('GF')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5 minutes

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        userId: req.user?.id ?? null,
        ipAddress: clientIp,
        chain: 'TRON',
        tier,
        gasAmountNative,
        gasAmountUSD,
        priceAtOrder,
        paymentCoin: 'USDT',
        paymentNetwork: 'TRC20',
        paymentAmount,
        toAddress,
        status: 'payment_pending',
        expiresAt,
      },
    })

    if (idempotencyKey) {
      await redis.setex(`idem:gasfee:${idempotencyKey}`, 86400, order.id)
    }

    return reply.code(201).send({
      success: true,
      data: {
        ...order,
        paymentAddress: env.GAS_FEE_DEPOSIT_ADDRESS_TRC20,
      },
    })
  })

  // GET /api/gas-fee/orders/:orderRef — no auth
  app.get('/gas-fee/orders/:orderRef', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({ success: true, data: order })
  })

  // GET /api/gas-fee/orders/:orderRef/refund-status — no auth
  app.get('/gas-fee/orders/:orderRef/refund-status', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef },
      select: {
        orderRef: true,
        status: true,
        refundedAt: true,
        failureReason: true,
      },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({
      success: true,
      data: {
        orderRef: order.orderRef,
        status: order.status,
        isRefunded: order.status === 'refunded',
        refundedAt: order.refundedAt,
        failureReason: order.failureReason,
      },
    })
  })
}
