import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import {
  getUserOrders,
  getOrderById,
  uploadPaymentProof,
  confirmCryptoDeposit,
} from '../services/instantBuy.service'
import { AppError } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'

const proofSchema = z.object({
  proofUrl: z.string().url(),
})

const depositSchema = z.object({
  txHash: z.string().min(1),
})

// Instant Buy was retired from the product in favor of Crypto Gas Fees (see
// frontend/src/app/(platform)/instant-buy/layout.tsx and commit 583a7328).
// The frontend entry points were redirected, but new-order creation stayed
// reachable by any authenticated client with no in-app admin review path.
// Quote/create are blocked below; everything an already-existing order needs
// (proof upload, deposit confirmation, webhook matching, OCR, admin
// approve/reject) is left working so nothing already in flight is stranded.
const RETIRED = {
  success: false,
  error: { code: 'GONE', message: 'Instant Buy has been retired. Use Crypto Gas Fees instead.' },
} as const

export async function instantBuyRoutes(app: FastifyInstance) {
  // POST /api/instant-buy/quote — retired, was a stateless price quote with 3-minute TTL
  app.post('/instant-buy/quote', async (_req, reply) => {
    return reply.code(410).send(RETIRED)
  })

  // POST /api/instant-buy/orders — retired, was quoteId flow OR legacy full params
  app.post('/instant-buy/orders', async (_req, reply) => {
    return reply.code(410).send(RETIRED)
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
    void createAdminNotif({
      category: 'TRADE',
      title:    'Instant Buy Awaiting Review',
      body:     `Order ${id} has payment proof uploaded and is awaiting admin review.`,
      href:     `/admin/instant-buy`,
      metadata: { orderId: id, userId: req.user!.id },
    })
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
