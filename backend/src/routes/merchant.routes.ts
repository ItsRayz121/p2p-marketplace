import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import {
  getMerchantProfile,
  activateMerchant,
  updateSpread,
  getMerchantInventory,
  addInventoryItem,
  getMerchantStats,
  getMerchantDashboard,
  getPublicMerchant,
} from '../services/merchant.service'
import { AppError, Errors } from '../lib/errors'
import { db } from '../lib/prisma'

const spreadSchema = z.object({
  spreadBps: z.number().int().min(0).max(2000),
})

const inventorySchema = z.object({
  coin: z.string().min(1).max(20),
  network: z.string().min(1).max(50),
  availableAmount: z.number().positive(),
  pricePerUnit: z.number().positive(),
})

export async function merchantRoutes(app: FastifyInstance) {
  // GET /api/merchants/me
  app.get('/merchants/me', { preHandler: [authenticate] }, async (req, reply) => {
    const profile = await getMerchantProfile(req.user!.id)
    return reply.send({ success: true, data: profile })
  })

  // POST /api/merchants/apply — RETIRED. There is a single KYC flow (POST /kyc/submit)
  // for everything now; the separate merchant application no longer exists, so a
  // stale client gets a clear 410 instead of creating a submission nobody reviews.
  app.post('/merchants/apply', { preHandler: [authenticate] }, async (_req, reply) => {
    return reply.code(410).send({
      success: false,
      error: 'GONE',
      message: 'Merchant KYC has been merged into the standard KYC. Please use the KYC page.',
    })
  })

  // POST /api/merchants/activate
  app.post('/merchants/activate', { preHandler: [authenticate] }, async (req, reply) => {
    const result = await activateMerchant(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // PATCH /api/merchants/me/spread
  app.patch('/merchants/me/spread', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = spreadSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const merchant = await updateSpread(req.user!.id, parsed.data.spreadBps)
    return reply.send({ success: true, data: merchant })
  })

  // GET /api/merchants/me/inventory
  app.get('/merchants/me/inventory', { preHandler: [authenticate] }, async (req, reply) => {
    const inventory = await getMerchantInventory(req.user!.id)
    return reply.send({ success: true, data: inventory })
  })

  // POST /api/merchants/me/inventory
  app.post('/merchants/me/inventory', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = inventorySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const item = await addInventoryItem(req.user!.id, parsed.data)
    return reply.code(201).send({ success: true, data: item })
  })

  // DELETE /api/merchants/me/inventory/:id
  app.delete('/merchants/me/inventory/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const merchant = await db.merchant.findUnique({ where: { userId: req.user!.id } })
    if (!merchant) throw Errors.NOT_FOUND('Merchant profile')

    const item = await db.merchantInventory.findFirst({
      where: { id, merchantId: merchant.id },
    })
    if (!item) throw Errors.NOT_FOUND('Inventory item')

    await db.merchantInventory.delete({ where: { id } })
    return reply.send({ success: true })
  })

  // GET /api/merchants/me/stats
  app.get('/merchants/me/stats', { preHandler: [authenticate] }, async (req, reply) => {
    const stats = await getMerchantStats(req.user!.id)
    return reply.send({ success: true, data: stats })
  })

  // GET /api/merchants/dashboard/summary
  app.get('/merchants/dashboard/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const dashboard = await getMerchantDashboard(req.user!.id)
    return reply.send({ success: true, data: dashboard })
  })

  // GET /api/merchants/:id — public
  app.get('/merchants/:id', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const merchant = await getPublicMerchant(id)
    return reply.send({ success: true, data: merchant })
  })
}
