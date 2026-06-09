import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AdminNotifCategory } from '@prisma/client'

const adminOrSuper = requireRole('admin', 'super_admin')
const VALID_CATEGORIES = new Set(Object.values(AdminNotifCategory))

function parseCategory(raw: string | undefined): AdminNotifCategory | undefined {
  if (raw && VALID_CATEGORIES.has(raw as AdminNotifCategory)) return raw as AdminNotifCategory
  return undefined
}

export async function adminNotificationRoutes(app: FastifyInstance) {
  // GET /admin/notifications
  app.get('/admin/notifications', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page     = Math.max(1, parseInt(q.page ?? '1', 10))
    const limit    = Math.min(parseInt(q.limit ?? '20', 10), 100)
    const skip     = (page - 1) * limit
    const unread   = q.unreadOnly === 'true'
    const category = parseCategory(q.category)

    const where = {
      ...(unread    ? { isRead: false } : {}),
      ...(category  ? { category }      : {}),
    }

    const [notifications, total, unreadCount] = await Promise.all([
      db.adminNotification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.adminNotification.count({ where }),
      db.adminNotification.count({ where: { isRead: false } }),
    ])

    return reply.send({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })

  // GET /admin/notifications/unread-count — bell badge
  app.get('/admin/notifications/unread-count', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q        = req.query as Record<string, string>
    const category = parseCategory(q.category)
    const count    = await db.adminNotification.count({
      where: { isRead: false, ...(category ? { category } : {}) },
    })
    return reply.send({ success: true, data: { count } })
  })

  // GET /admin/nav-counts — live pending counts for sidebar queue badges.
  // kyc_reviewer is allowed so the KYC Queue badge shows for that role too.
  app.get(
    '/admin/nav-counts',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'kyc_reviewer')] },
    async (_req, reply) => {
      const [kyc, appeals, disputes, ctmDisputes, withdrawals, gasRequests] = await Promise.all([
        db.kycSubmission.count({ where: { status: 'pending' } }),
        db.appeal.count({ where: { status: { in: ['pending', 'more_info_requested'] } } }),
        db.dispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.ctmDispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.withdrawal.count({ where: { status: { in: ['pending', 'first_approved'] } } }),
        db.gasCustomRequest.count({ where: { status: 'pending' } }),
      ])
      return reply.send({
        success: true,
        data: { kyc, appeals, disputes, ctmDisputes, withdrawals, gasRequests },
      })
    },
  )

  // PATCH /admin/notifications/:id/read
  app.patch('/admin/notifications/:id/read', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.adminNotification.update({ where: { id }, data: { isRead: true } })
    return reply.send({ success: true })
  })

  // PATCH /admin/notifications/read-all?category=
  app.patch('/admin/notifications/read-all', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q        = req.query as Record<string, string>
    const category = parseCategory(q.category)
    await db.adminNotification.updateMany({
      where: { isRead: false, ...(category ? { category } : {}) },
      data:  { isRead: true },
    })
    return reply.send({ success: true })
  })

  // DELETE /admin/notifications/old — prune notifications older than 30 days
  app.delete('/admin/notifications/old', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const { count } = await db.adminNotification.deleteMany({
      where: { createdAt: { lt: cutoff }, isRead: true },
    })
    return reply.send({ success: true, data: { deleted: count } })
  })
}
