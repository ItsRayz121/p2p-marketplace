import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { recordAuditLog } from '../lib/audit'
import {
  approveShareReward, getActiveShareReward, getShareInfo, listShareRewards,
  rejectShareReward, submitSharePost,
} from '../lib/gas/gas.share'

const adminOrSuper = requireRole('admin', 'super_admin')

/** Share & Earn: post about a delivered gas order on X → random margin discount on the next order. */
export async function gasShareRoutes(app: FastifyInstance) {
  // GET /gas-fee/share/active — does the user hold an approved discount? (checkout banner)
  app.get('/gas-fee/share/active', { preHandler: [authenticate] }, async (req, reply) => {
    return reply.send({ success: true, data: await getActiveShareReward(req.user!.id) })
  })

  // GET /gas-fee/share/orders/:orderRef?variant=N — post text + this order's reward state
  app.get('/gas-fee/share/orders/:orderRef', { preHandler: [authenticate] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const variant = Math.max(0, Math.min(50, parseInt((req.query as { variant?: string }).variant ?? '0', 10) || 0))
    return reply.send({ success: true, data: await getShareInfo(req.user!.id, orderRef, variant) })
  })

  // POST /gas-fee/share/orders/:orderRef/submit — submit the X post link for review
  app.post('/gas-fee/share/orders/:orderRef/submit', { preHandler: [authenticate] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const parsed = z.object({ url: z.string().min(10).max(300) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Paste the link to your post', 400)
    return reply.code(201).send({ success: true, data: await submitSharePost(req.user!.id, orderRef, parsed.data.url) })
  })

  // ── Admin review queue ────────────────────────────────────────────────────
  app.get('/admin/gas/share-rewards', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { status } = req.query as { status?: string }
    return reply.send({ success: true, data: await listShareRewards(status) })
  })

  app.post('/admin/gas/share-rewards/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await approveShareReward(id, req.user!.id)
    await recordAuditLog(req.user!.id, 'GAS_SHARE_REWARD_APPROVED', 'GasShareReward', id, result)
    return reply.send({ success: true, data: result })
  })

  app.post('/admin/gas/share-rewards/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ reason: z.string().max(300).optional() }).safeParse(req.body ?? {})
    const reason = body.success ? (body.data.reason ?? '') : ''
    await rejectShareReward(id, req.user!.id, reason)
    await recordAuditLog(req.user!.id, 'GAS_SHARE_REWARD_REJECTED', 'GasShareReward', id, { reason })
    return reply.send({ success: true, data: { status: 'rejected' } })
  })
}
