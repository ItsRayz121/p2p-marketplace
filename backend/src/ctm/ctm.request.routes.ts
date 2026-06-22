import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  createRequest,
  getRequests,
  getRequestById,
  getMyRequestsAndBids,
  submitBid,
  withdrawBid,
  acceptBid,
  cancelRequest,
} from './ctm.request.service'

const createRequestSchema = z.object({
  tokenId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  amount: z.number().positive(),
  targetPricePkr: z.number().positive().optional(),
  paymentMethods: z.array(z.string()).min(1),
  note: z.string().max(500).optional(),
  expiryHours: z.number().int().min(1).max(24).optional(),
})

const bidSchema = z.object({
  pricePerUnit: z.number().positive(),
  message: z.string().max(300).optional(),
  bidExpiryHours: z.number().int().min(1).max(12).optional(),
  paymentMethodId: z.string().min(1),
  buyerSettlementId: z.string().max(500).optional(),
})

const acceptBidSchema = z.object({
  paymentMethodId: z.string().min(1),
  settlementId: z.string().max(500).optional(),
})

export async function ctmRequestRoutes(app: FastifyInstance) {
  // GET /ctm/requests — browse open requests
  app.get('/ctm/requests', { preHandler: [optionalAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await getRequests({
      ...(q.tokenId ? { tokenId: q.tokenId } : {}),
      ...(q.side ? { side: q.side } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/requests/me — my requests + my bids
  app.get('/ctm/requests/me', { preHandler: [authenticate] }, async (req, reply) => {
    const result = await getMyRequestsAndBids(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/requests/:id — request detail
  app.get('/ctm/requests/:id', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const viewerId = req.user?.id
    const request = await getRequestById(id, viewerId)
    return reply.send({ success: true, data: request })
  })

  // POST /ctm/requests — post new request
  app.post('/ctm/requests', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = createRequestSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = await createRequest(req.user!.id, parsed.data as any)
    return reply.code(201).send({ success: true, data: request })
  })

  // DELETE /ctm/requests/:id — cancel open request
  app.delete('/ctm/requests/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await cancelRequest(req.user!.id, id)
    return reply.send({ success: true })
  })

  // POST /ctm/requests/:id/bids — submit bid
  app.post('/ctm/requests/:id/bids', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = bidSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bid = await submitBid(req.user!.id, id, parsed.data as any)
    return reply.code(201).send({ success: true, data: bid })
  })

  // DELETE /ctm/requests/:id/bids/:bidId — withdraw own bid
  app.delete('/ctm/requests/:id/bids/:bidId', { preHandler: [authenticate] }, async (req, reply) => {
    const { id, bidId } = req.params as { id: string; bidId: string }
    await withdrawBid(req.user!.id, id, bidId)
    return reply.send({ success: true })
  })

  // POST /ctm/requests/:id/accept/:bidId — accept bid → create trade
  app.post('/ctm/requests/:id/accept/:bidId', { preHandler: [authenticate] }, async (req, reply) => {
    const { id, bidId } = req.params as { id: string; bidId: string }
    const parsed = acceptBidSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const trade = await acceptBid(req.user!.id, id, bidId, {
      paymentMethodId: parsed.data.paymentMethodId,
      ...(parsed.data.settlementId !== undefined ? { settlementId: parsed.data.settlementId } : {}),
    })
    return reply.code(201).send({ success: true, data: trade })
  })
}
