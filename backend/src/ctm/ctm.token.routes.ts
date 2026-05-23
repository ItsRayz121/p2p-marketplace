import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole, optionalAuth } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'
import {
  listApprovedTokens,
  getTokenBySlug,
  adminCreateToken,
  adminUpdateToken,
  adminDelistToken,
  submitTokenRequest,
  listTokenRequests,
  approveTokenRequest,
  rejectTokenRequest,
} from './ctm.token.service'

const suggestSchema = z.object({
  tokenName: z.string().min(1).max(100),
  tokenSymbol: z.string().min(1).max(20),
  description: z.string().min(10).max(1000),
  officialWebsite: z.string().url().optional(),
  evidenceUrl: z.string().url().optional(),
})

const adminCreateSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  symbol: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  logoUrl: z.string().url().optional(),
  bannerUrl: z.string().url().optional(),
  settlementType: z.enum(['MANUAL', 'ON_CHAIN', 'HYBRID']),
  network: z.string().max(100).optional(),
  contractAddress: z.string().max(200).optional(),
  explorerUrl: z.string().url().optional(),
  officialWebsite: z.string().url().optional(),
  officialTwitter: z.string().url().optional(),
  officialTelegram: z.string().url().optional(),
  whitePaperUrl: z.string().url().optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'extreme']).optional(),
  riskNotes: z.string().max(1000).optional(),
  riskLabels: z.array(z.string()).optional(),
  maxListingAmount: z.number().positive().optional(),
  minTradeAmountPkr: z.number().positive().optional(),
})

const adminUpdateSchema = z.object({
  status: z.enum(['pending_review', 'approved', 'rejected', 'delisted', 'restricted']).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'extreme']).optional(),
  riskNotes: z.string().max(1000).optional(),
  riskLabels: z.array(z.string()).optional(),
  isListingEnabled: z.boolean().optional(),
  logoUrl: z.string().url().optional(),
  maxListingAmount: z.number().positive().optional(),
  minTradeAmountPkr: z.number().positive().optional(),
  description: z.string().max(2000).optional(),
})

const rejectSchema = z.object({ adminNote: z.string().min(1).max(500) })

export async function ctmTokenRoutes(app: FastifyInstance) {
  // GET /ctm/tokens — public browse (adminView=true requires admin role)
  app.get('/ctm/tokens', { preHandler: [optionalAuth] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    const adminView = isAdmin && q.adminView === 'true'
    const result = await listApprovedTokens({
      ...(q.search ? { search: q.search } : {}),
      ...(q.settlementType ? { settlementType: q.settlementType as never } : {}),
      ...(q.riskTier ? { riskTier: q.riskTier as never } : {}),
      ...(q.status && adminView ? { status: q.status as never } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
      adminView,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/tokens/admin/queue — pending token requests
  app.get('/ctm/tokens/admin/queue', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await listTokenRequests({
      status: q.status ?? 'pending',
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return reply.send({ success: true, data: result })
  })

  // POST /ctm/tokens/admin — admin create token
  app.post('/ctm/tokens/admin', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const parsed = adminCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await adminCreateToken(req.user!.id, parsed.data as any)
    return reply.code(201).send({ success: true, data: token })
  })

  // POST /ctm/tokens/suggest — user suggests new token
  app.post('/ctm/tokens/suggest', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = suggestSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = await submitTokenRequest(req.user!.id, parsed.data as any)
    void createAdminNotif({
      category: 'CTM',
      title:    'New CTM Token Suggestion',
      body:     `A user suggested a new token for CTM listing. Request ID: ${request.id}`,
      href:     `/admin/ctm/tokens/queue`,
      metadata: { userId: req.user!.id, requestId: request.id },
    })
    return reply.code(201).send({ success: true, data: request })
  })

  // GET /ctm/tokens/:slug — token detail
  app.get('/ctm/tokens/:slug', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const token = await getTokenBySlug(slug)
    return reply.send({ success: true, data: token })
  })

  // PATCH /ctm/tokens/admin/:id — admin update token
  app.patch('/ctm/tokens/admin/:id', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = adminUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await adminUpdateToken(req.user!.id, id, parsed.data as any)
    return reply.send({ success: true, data: token })
  })

  // POST /ctm/tokens/admin/:id/approve — approve token request
  app.post('/ctm/tokens/admin/:id/approve', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = adminCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = await approveTokenRequest(req.user!.id, id, parsed.data as any)
    return reply.code(201).send({ success: true, data: token })
  })

  // POST /ctm/tokens/admin/:id/reject — reject token request
  app.post('/ctm/tokens/admin/:id/reject', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = rejectSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const result = await rejectTokenRequest(req.user!.id, id, parsed.data.adminNote)
    return reply.send({ success: true, data: result })
  })

  // POST /ctm/tokens/admin/:id/delist — delist live token
  app.post('/ctm/tokens/admin/:id/delist', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await adminDelistToken(req.user!.id, id)
    return reply.send({ success: true })
  })
}
