import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  createListing,
  getListings,
  getListingById,
  getListingActivity,
  updateListing,
  pauseListing,
  activateListing,
  deleteListing,
} from './ctm.listing.service'
import { createTradeFromListing } from './ctm.trade.service'

const createListingSchema = z.object({
  tokenId: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  settlementType: z.enum(['MANUAL', 'ON_CHAIN', 'HYBRID']),
  pricePerUnit: z.number().positive(),
  totalAmount: z.number().positive(),
  minOrderTokens: z.number().positive(),
  maxOrderTokens: z.number().positive(),
  settlementMethod: z.string().max(100).optional(),
  tokenDeliveryType: z.enum(['blockchain', 'email', 'username']).optional(),
  settlementNote: z.string().max(1000).optional().default(''),
  paymentMethods: z.array(z.string()).default([]),
  tradeWindowMins: z.number().int().min(15).max(240).optional(),
  terms: z.string().max(2000).optional(),
  requiresProof: z.boolean().optional(),
  proofInstructions: z.string().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
}).superRefine((data, ctx) => {
  if (data.side === 'sell' && data.paymentMethods.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select at least one payment method', path: ['paymentMethods'] })
  }
})

const updateListingSchema = z.object({
  pricePerUnit: z.number().positive().optional(),
  minOrderTokens: z.number().positive().optional(),
  maxOrderTokens: z.number().positive().optional(),
  terms: z.string().max(2000).optional(),
  paymentMethods: z.array(z.string()).min(1).optional(),
  settlementNote: z.string().max(1000).optional(),
  tradeWindowMins: z.number().int().min(15).max(240).optional(),
})

export async function ctmListingRoutes(app: FastifyInstance) {
  // GET /ctm/listings — browse listings
  app.get('/ctm/listings', { preHandler: [optionalAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await getListings({
      ...(q.tokenId ? { tokenId: q.tokenId } : {}),
      ...(q.side ? { side: q.side } : {}),
      ...(q.paymentMethod ? { paymentMethod: q.paymentMethod } : {}),
      ...(q.tier ? { tier: q.tier } : {}),
      ...(q.sortBy ? { sortBy: q.sortBy } : {}),
      ...(q.sortDir === 'asc' || q.sortDir === 'desc' ? { sortDir: q.sortDir } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/listings/me — my listings
  app.get('/ctm/listings/me', { preHandler: [authenticate] }, async (req, reply) => {
    const { db } = await import('../lib/prisma')
    const profile = await db.ctmMerchantProfile.findUnique({ where: { userId: req.user!.id }, select: { id: true } })
    if (!profile) return reply.send({ success: true, data: { listings: [], total: 0, page: 1, limit: 20, totalPages: 0 } })
    // Update lastActiveAt fire-and-forget
    db.ctmMerchantProfile.update({ where: { id: profile.id }, data: { lastActiveAt: new Date() } }).catch(() => {})
    const result = await getListings({ merchantProfileId: profile.id, adminView: true })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/listings/admin/all — admin view all listings
  app.get('/ctm/listings/admin/all', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await getListings({
      ...(q.tokenId ? { tokenId: q.tokenId } : {}),
      ...(q.side ? { side: q.side } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
      adminView: true,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/listings/:id — listing detail
  app.get('/ctm/listings/:id', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const listing = await getListingById(id)
    return reply.send({ success: true, data: listing })
  })

  // GET /ctm/listings/:id/activity — public aggregate stats + owner-only full bids/trades
  app.get('/ctm/listings/:id/activity', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = await getListingActivity(id, req.user?.id)
    return reply.send({ success: true, data })
  })

  // POST /ctm/listings — create listing
  app.post('/ctm/listings', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = createListingSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listing = await createListing(req.user!.id, parsed.data as any)
    return reply.code(201).send({ success: true, data: listing })
  })

  // PATCH /ctm/listings/:id — update listing
  app.patch('/ctm/listings/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = updateListingSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listing = await updateListing(req.user!.id, id, parsed.data as any)
    return reply.send({ success: true, data: listing })
  })

  // POST /ctm/listings/:id/pause — pause listing
  app.post('/ctm/listings/:id/pause', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const listing = await pauseListing(req.user!.id, id)
    return reply.send({ success: true, data: listing })
  })

  // POST /ctm/listings/:id/activate — reactivate listing
  app.post('/ctm/listings/:id/activate', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const listing = await activateListing(req.user!.id, id)
    return reply.send({ success: true, data: listing })
  })

  // POST /ctm/listings/:id/trade — start a trade from a listing
  app.post('/ctm/listings/:id/trade', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({
      paymentMethod: z.string().min(1).optional(),
      paymentMethods: z.array(z.string().min(1)).min(1).optional(),
      buyerSettlementId: z.string().max(500).optional(),
      buyerPaymentMethodId: z.string().min(1).optional(),
      tokenAmount: z.number().positive(),
    }).refine((d) => d.paymentMethod || (d.paymentMethods && d.paymentMethods.length > 0), {
      message: 'paymentMethod or paymentMethods is required',
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trade = await createTradeFromListing(req.user!.id, id, parsed.data as any)
    return reply.code(201).send({ success: true, data: trade })
  })

  // DELETE /ctm/listings/:id — cancel/delete listing
  app.delete('/ctm/listings/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await deleteListing(req.user!.id, id)
    return reply.send({ success: true })
  })
}
