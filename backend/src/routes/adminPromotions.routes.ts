import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { promotionsOverview } from '../lib/gas/promotions.overview'

const adminOrSuper = requireRole('admin', 'super_admin')

export async function adminPromotionRoutes(app: FastifyInstance) {
  // GET /admin/promotions/overview?days=7|30|90|all — read-only reporting across every promotion program.
  app.get('/admin/promotions/overview', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const raw = (req.query as { days?: string }).days
    const days = raw === 'all' ? null : ([7, 30, 90] as const).find((d) => String(d) === raw) ?? 30
    return reply.send({ success: true, data: await promotionsOverview(days) })
  })
}
