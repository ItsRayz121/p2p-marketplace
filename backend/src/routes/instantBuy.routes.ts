import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import {
  createOrder,
  getUserOrders,
  getOrderById,
  uploadPaymentProof,
  confirmCryptoDeposit,
} from '../services/instantBuy.service'
import { AppError } from '../lib/errors'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { randomUUID } from 'crypto'

const createOrderSchema = z.object({
  coin: z.string().min(1).max(20),
  network: z.string().min(1).max(50),
  paymentMode: z.enum(['pkr', 'crypto']),
  amount: z.number().positive(),
  destinationAddress: z.string().min(1),
})

// Quote schema — frontend sends { coin, amountPkr } or { quoteId, paymentMethod, ... }
const quoteSchema = z.object({
  coin: z.string().min(1).max(20),
  amountPkr: z.number().positive(),
})

const executeOrderSchema = z.object({
  quoteId: z.string().uuid(),
  paymentMethod: z.string().min(1).optional(),
  destinationAddress: z.string().min(1).optional(),
})

const proofSchema = z.object({
  proofUrl: z.string().url(),
})

const depositSchema = z.object({
  txHash: z.string().min(1),
})

export async function instantBuyRoutes(app: FastifyInstance) {
  // POST /api/instant-buy/quote — stateless price quote with 3-minute TTL
  app.post('/instant-buy/quote', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = quoteSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { coin, amountPkr } = parsed.data
    const coinUpper = coin.toUpperCase()

    const rateRaw = await redis.get(`rate:${coinUpper}`)
    if (!rateRaw) throw new AppError('RATE_UNAVAILABLE', 'Live rate not available. Try again shortly.', 503)
    const { rate } = JSON.parse(rateRaw) as { rate: number }

    const config = await db.platformConfig.findUnique({ where: { key: 'instant_buy_fee_pct' } })
    const feePct = parseFloat(config?.value ?? '1.5')

    const amountCrypto = amountPkr / rate
    const fee = amountCrypto * feePct / 100
    const netCrypto = amountCrypto - fee

    const quoteId = randomUUID()
    const quotePayload = JSON.stringify({ coin: coinUpper, amountPkr, amountCrypto, rate, feePct, fee, netCrypto })
    await redis.setex(`quote:${quoteId}`, 180, quotePayload)

    return reply.send({
      success: true,
      data: {
        quoteId,
        coin: coinUpper,
        amountPkr,
        amountCrypto: amountCrypto.toFixed(8),
        rate,
        fee: fee.toFixed(8),
        netCrypto: netCrypto.toFixed(8),
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      },
    })
  })

  // POST /api/instant-buy/orders — accepts quoteId flow OR legacy full params
  app.post('/instant-buy/orders', { preHandler: [authenticate] }, async (req, reply) => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined

    // Try quote-based flow first
    const quoteParsed = executeOrderSchema.safeParse(req.body)
    if (quoteParsed.success && quoteParsed.data.quoteId) {
      const { quoteId, paymentMethod, destinationAddress } = quoteParsed.data
      const quoteRaw = await redis.get(`quote:${quoteId}`)
      if (!quoteRaw) throw new AppError('QUOTE_EXPIRED', 'Quote has expired. Please get a new price.', 400)
      const quote = JSON.parse(quoteRaw) as { coin: string; amountPkr: number; amountCrypto: number; rate: number; fee: number; netCrypto: number }
      const DEFAULT_NETWORKS: Record<string, string> = { USDT: 'TRC20', BTC: 'BTC', ETH: 'ERC20', BNB: 'BEP20', TRX: 'TRC20' }
      const network = DEFAULT_NETWORKS[quote.coin] ?? 'TRC20'
      const result = await createOrder(req.user!.id, {
        coin: quote.coin,
        network,
        paymentMode: paymentMethod?.toLowerCase().includes('crypto') ? 'crypto' : 'pkr',
        amount: quote.amountPkr,
        destinationAddress: destinationAddress ?? '',
        ...(idempotencyKey ? { idempotencyKey } : {}),
      })
      await redis.del(`quote:${quoteId}`)
      return reply.code(201).send({ success: true, data: result })
    }

    // Legacy flow
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const result = await createOrder(req.user!.id, {
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    return reply.code(201).send({ success: true, data: result })
  })

  // GET /api/instant-buy/orders
  app.get('/instant-buy/orders', { preHandler: [authenticate] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const result = await getUserOrders(req.user!.id, {
      page: query.page ? parseInt(query.page, 10) : 1,
      limit: query.limit ? parseInt(query.limit, 10) : 20,
      ...(query.status ? { status: query.status } : {}),
    })
    return reply.send({ success: true, data: result })
  })

  // GET /api/instant-buy/orders/:id
  app.get('/instant-buy/orders/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await getOrderById(id, req.user!.id)
    return reply.send({ success: true, data: order })
  })

  // POST /api/instant-buy/orders/:id/payment
  app.post('/instant-buy/orders/:id/payment', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = proofSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const order = await uploadPaymentProof(id, req.user!.id, parsed.data.proofUrl)
    return reply.send({ success: true, data: order })
  })

  // POST /api/instant-buy/orders/:id/confirm-deposit
  app.post('/instant-buy/orders/:id/confirm-deposit', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = depositSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const order = await confirmCryptoDeposit(id, req.user!.id, parsed.data.txHash)
    return reply.send({ success: true, data: order })
  })
}
