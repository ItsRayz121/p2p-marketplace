import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { affiliateOverview, affiliateDetail } from '../lib/gas/gas.affiliateReport'
import { AppError } from '../lib/errors'

const adminOrSuper = requireRole('admin', 'super_admin')

export async function adminAffiliateRoutes(app: FastifyInstance) {
  // GET /admin/affiliates/overview — counts, commission states and per-affiliate performance (read-only).
  app.get('/admin/affiliates/overview', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    return reply.send({ success: true, data: await affiliateOverview() })
  })

  // GET /admin/affiliates/:userId/detail — links, recent accruals, payouts and audit history for one affiliate.
  app.get('/admin/affiliates/:userId/detail', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const data = await affiliateDetail(userId)
    if (!data) throw new AppError('NOT_FOUND', 'Affiliate not found', 404)
    return reply.send({ success: true, data })
  })
}
