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

const createOrderSchema = z.object({
  coin: z.string().min(1).max(20),
  network: z.string().min(1).max(50),
  paymentMode: z.enum(['pkr', 'crypto']),
  amount: z.number().positive(),
  destinationAddress: z.string().min(1),
})

const proofSchema = z.object({
  proofUrl: z.string().url(),
})

const depositSchema = z.object({
  txHash: z.string().min(1),
})

export async function instantBuyRoutes(app: FastifyInstance) {
  // POST /api/instant-buy/orders
  app.post('/instant-buy/orders', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined
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
