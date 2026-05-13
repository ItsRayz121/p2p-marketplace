import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import {
  createAd,
  getUserAds,
  updateAd,
  toggleAdStatus,
  deleteAd,
} from '../services/ad.service'
import { AppError } from '../lib/errors'

const createAdSchema = z.object({
  side: z.enum(['buy', 'sell']),
  coin: z.string().min(1),
  network: z.string().min(1),
  priceType: z.enum(['fixed', 'float']),
  price: z.number().positive(),
  floatOffset: z.number().optional(),
  totalAmount: z.number().positive(),
  minOrder: z.number().positive(),
  maxOrder: z.number().positive(),
  paymentMethods: z.array(z.string()).min(1),
  tradeWindow: z.number().int().min(5).max(720).optional(),
  terms: z.string().max(2000).optional(),
})

const updateAdSchema = z.object({
  price: z.number().positive().optional(),
  floatOffset: z.number().optional(),
  minOrder: z.number().positive().optional(),
  maxOrder: z.number().positive().optional(),
  availableAmount: z.number().positive().optional(),
  paymentMethods: z.array(z.string()).min(1).optional(),
  tradeWindow: z.number().int().min(5).max(720).optional(),
  terms: z.string().max(2000).optional(),
})

const toggleStatusSchema = z.object({
  status: z.enum(['active', 'paused']),
})

export async function adRoutes(app: FastifyInstance) {
  // POST /api/ads — create ad
  app.post('/ads', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = createAdSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const ad = await createAd(userId, parsed.data as any)
    return reply.code(201).send({ success: true, data: ad })
  })

  // GET /api/ads — user's own ads (also exposed at /ads/me for frontend convenience)
  for (const path of ['/ads', '/ads/me'] as const) {
    app.get(path, { preHandler: [authenticate] }, async (req, reply) => {
      const userId = req.user!.id
      const query = req.query as Record<string, string>
      const result = await getUserAds(userId, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.page ? { page: parseInt(query.page) } : {}),
        ...(query.limit ? { limit: parseInt(query.limit) } : {}),
      })
      return reply.send({ success: true, data: result })
    })
  }

  // PATCH /api/ads/:id — update ad
  app.patch('/ads/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = updateAdSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const ad = await updateAd(userId, id, parsed.data as any)
    return reply.send({ success: true, data: ad })
  })

  // PATCH /api/ads/:id/status — pause/activate
  app.patch('/ads/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = toggleStatusSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const ad = await toggleAdStatus(userId, id, parsed.data.status)
    return reply.send({ success: true, data: ad })
  })

  // POST /api/ads/:id/pause — alias of PATCH /:id/status { status: 'paused' }
  app.post('/ads/:id/pause', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const ad = await toggleAdStatus(userId, id, 'paused')
    return reply.send({ success: true, data: ad })
  })

  // POST /api/ads/:id/activate — alias of PATCH /:id/status { status: 'active' }
  app.post('/ads/:id/activate', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const ad = await toggleAdStatus(userId, id, 'active')
    return reply.send({ success: true, data: ad })
  })

  // DELETE /api/ads/:id — soft delete
  app.delete('/ads/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const ad = await deleteAd(userId, id)
    return reply.send({ success: true, data: ad })
  })
}
