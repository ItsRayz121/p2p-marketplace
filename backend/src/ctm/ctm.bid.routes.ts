import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { placeBid, acceptListingBid, rejectListingBid, cancelListingBid, getListingBids, getMyBids } from './ctm.bid.service'

const placeBidSchema = z.object({
  pricePerUnit: z.number().positive(),
  tokenAmount: z.number().positive(),
  message: z.string().max(300).optional(),
  paymentMethod: z.string().min(1).optional(),
  paymentMethods: z.array(z.string().min(1)).optional(),
  buyerSettlementId: z.string().max(500).optional(),
  buyerPaymentMethodId: z.string().min(1).optional(),
})

export async function ctmBidRoutes(app: FastifyInstance) {
  // POST /ctm/listings/:id/bids — place a bid on a listing
  app.post('/ctm/listings/:id/bids', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = placeBidSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bid = await placeBid(req.user!.id, id, parsed.data as any)
    return reply.code(201).send({ success: true, data: bid })
  })

  // GET /ctm/listings/:id/bids — merchant views bids on their listing
  app.get('/ctm/listings/:id/bids', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bids = await getListingBids(id, req.user!.id)
    return reply.send({ success: true, data: bids })
  })

  // GET /ctm/bids/me — my placed bids
  app.get('/ctm/bids/me', { preHandler: [authenticate] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await getMyBids(req.user!.id, q.page ? parseInt(q.page, 10) : 1, q.limit ? parseInt(q.limit, 10) : 20)
    return reply.send({ success: true, data: result })
  })

  // POST /ctm/bids/:bidId/accept — merchant accepts a bid → opens trade
  app.post('/ctm/bids/:bidId/accept', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    const trade = await acceptListingBid(req.user!.id, bidId)
    return reply.code(201).send({ success: true, data: trade })
  })

  // POST /ctm/bids/:bidId/reject — merchant rejects a bid
  app.post('/ctm/bids/:bidId/reject', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    await rejectListingBid(req.user!.id, bidId)
    return reply.send({ success: true })
  })

  // DELETE /ctm/bids/:bidId — bidder cancels their own bid
  app.delete('/ctm/bids/:bidId', { preHandler: [authenticate] }, async (req, reply) => {
    const { bidId } = req.params as { bidId: string }
    await cancelListingBid(req.user!.id, bidId)
    return reply.send({ success: true })
  })
}
