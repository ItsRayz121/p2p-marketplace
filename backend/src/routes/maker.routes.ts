import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { getMakerStatus, isMakerGateOn } from '../lib/makerGate'
import {
  saveWhatsappNumber, applyForMaker, listMakerApplications, decideMaker, listPendingAds, reviewPendingAd,
  getMakerReviewSettings, saveMakerReviewSettings,
} from '../services/maker.service'

const adminOrSuper = requireRole('admin', 'super_admin')
const rate = { rateLimit: { max: 30, timeWindow: '1 minute' } }

/** Maker approval + new-ad review queue. Everything is inert until maker_gate_enabled is ON. */
export async function makerRoutes(app: FastifyInstance) {
  // ── User side ──
  app.get('/maker/status', { preHandler: [authenticate] }, async (req, reply) => {
    return reply.send({ success: true, data: await getMakerStatus(req.user!.id) })
  })

  app.post('/maker/whatsapp', { preHandler: [authenticate], config: rate }, async (req, reply) => {
    const parsed = z.object({ whatsappNumber: z.string().min(5).max(32) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Enter your WhatsApp number', 400)
    return reply.send({ success: true, data: await saveWhatsappNumber(req.user!.id, parsed.data.whatsappNumber) })
  })

  app.post('/maker/apply', { preHandler: [authenticate], config: rate }, async (req, reply) => {
    return reply.send({ success: true, data: await applyForMaker(req.user!.id) })
  })

  // ── Admin: maker applications ──
  app.get('/admin/makers', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Invalid status', 400)
    return reply.send({
      success: true,
      data: { gateEnabled: await isMakerGateOn(), applications: await listMakerApplications(q.data.status) },
    })
  })

  app.post('/admin/makers/:id/decision', { preHandler: [authenticate, adminOrSuper], config: rate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'approve (boolean) is required', 400)
    await decideMaker(req.user!.id, id, parsed.data.approve, parsed.data.note)
    return reply.send({ success: true })
  })

  // ── Admin: review rules (how many ads, or what size, need approval) ──
  app.get('/admin/makers/settings', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    return reply.send({ success: true, data: await getMakerReviewSettings() })
  })

  app.put('/admin/makers/settings', { preHandler: [authenticate, adminOrSuper], config: rate }, async (req, reply) => {
    const parsed = z.object({
      reviewFirstN: z.number().int().min(0).max(50),
      reviewAboveUsdt: z.number().min(0).max(1_000_000),
      contactTelegram: z.string().trim().max(100).default(''),
    }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Ads to review must be 0-50 and the size threshold 0-1,000,000', 400)
    return reply.send({ success: true, data: await saveMakerReviewSettings(req.user!.id, parsed.data) })
  })

  // ── Admin: ad review queue ──
  app.get('/admin/ad-review', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    return reply.send({ success: true, data: await listPendingAds() })
  })

  app.post('/admin/ad-review/:kind/:id/decision', { preHandler: [authenticate, adminOrSuper], config: rate }, async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string }
    if (kind !== 'usdt' && kind !== 'ctm') throw new AppError('VALIDATION_ERROR', 'kind must be usdt or ctm', 400)
    const parsed = z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'approve (boolean) is required', 400)
    await reviewPendingAd(req.user!.id, kind, id, parsed.data.approve, parsed.data.note)
    return reply.send({ success: true })
  })
}
