import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { createAdminNotif } from '../services/adminNotification.service'
import {
  getMerchantProfile,
  applyMerchant,
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

const applySchema = z.object({
  businessName: z.string().min(2).max(200),
  description: z.string().min(10).max(1000),
  proofUrl: z.string().url().optional(),
  cnicFrontUrl: z.string().url().optional(),
  cnicBackUrl: z.string().url().optional(),
  selfieUrl: z.string().url().optional(),
})

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

  // POST /api/merchants/apply
  app.post('/merchants/apply', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = applySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { businessName, description, proofUrl, cnicFrontUrl, cnicBackUrl, selfieUrl } = parsed.data
    const submission = await applyMerchant(req.user!.id, {
      businessName,
      description,
      ...(proofUrl !== undefined ? { proofUrl } : {}),
      ...(cnicFrontUrl !== undefined ? { cnicFrontUrl } : {}),
      ...(cnicBackUrl !== undefined ? { cnicBackUrl } : {}),
      ...(selfieUrl !== undefined ? { selfieUrl } : {}),
    })
    void createAdminNotif({
      category: 'KYC',
      title:    'Merchant KYC Application',
      body:     `New merchant KYC application from user ${req.user!.id}. Business: ${businessName}`,
      href:     `/admin/merchant-kyc`,
      metadata: { userId: req.user!.id, businessName },
    })
    return reply.code(201).send({ success: true, data: submission })
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
