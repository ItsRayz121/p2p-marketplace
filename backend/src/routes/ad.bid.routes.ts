import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  placeBid,
  acceptAdBid,
  confirmBidDetails,
  rejectAdBid,
  cancelAdBid,
  getAdActivity,
  getMyAdBids,
} from '../services/ad.bid.service'

const placeBidSchema = z.object({
  pricePerUnit: z.number().positive(),
  usdtAmount: z.number().positive(),
  message: z.string().max(300).optional().transform((v) => v ?? undefined),
})

const confirmBidSchema = z.object({
  paymentMethod: z.string().min(1),
  buyerUsdtAddress: z.string().max(300).optional().transform((v) => v ?? undefined),
})

export async function adBidRoutes(app: FastifyInstance) {
  // GET /api/ads/:id/activity — public aggregate + owner-only bids/trades
  app.get('/ads/:id/activity', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = await getAdActivity(id, req.user?.id)
    return reply.send({ success: true, data })
  })

  // POST /api/ads/:id/bids — place a bid on a listing
  app.post('/ads/:id/bids', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = placeBidSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const bid = await placeBid(req.user!.id, id, parsed.data)
    return reply.code(201).send({ success: true, data: bid })
  })

  // POST /api/ads/bids/:bidId/accept — ad owner accepts a bid
  app.post('/ads/bids/:bidId/accept', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    const result = await acceptAdBid(req.user!.id, bidId)
    return reply.send({ success: true, data: result })
  })

  // POST /api/ads/bids/:bidId/confirm — bidder confirms payment details to open trade
  app.post('/ads/bids/:bidId/confirm', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    const parsed = confirmBidSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const trade = await confirmBidDetails(req.user!.id, bidId, parsed.data)
    return reply.code(201).send({ success: true, data: trade })
  })

  // POST /api/ads/bids/:bidId/reject — ad owner rejects a bid
  app.post('/ads/bids/:bidId/reject', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    await rejectAdBid(req.user!.id, bidId)
    return reply.send({ success: true })
  })

  // POST /api/ads/bids/:bidId/cancel — bidder cancels their own bid
  app.post('/ads/bids/:bidId/cancel', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    await cancelAdBid(req.user!.id, bidId)
    return reply.send({ success: true })
  })

  // GET /api/ads/bids/mine — bidder's own bids history
  app.get('/ads/bids/mine', { preHandler: [authenticate] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const result = await getMyAdBids(
      req.user!.id,
      query.page ? parseInt(query.page) : 1,
      query.limit ? parseInt(query.limit) : 20,
    )
    return reply.send({ success: true, data: result })
  })
}
