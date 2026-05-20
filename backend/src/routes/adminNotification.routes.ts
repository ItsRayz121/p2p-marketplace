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
