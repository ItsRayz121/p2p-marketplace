import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { Errors } from '../lib/errors'

export async function notificationRoutes(app: FastifyInstance) {
  // GET /api/notifications
  app.get('/notifications', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const page = query.page ? parseInt(query.page, 10) : 1
    const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
    const unreadOnly = query.unreadOnly === 'true'
    const skip = (page - 1) * limit

    const where = { userId, ...(unreadOnly ? { isRead: false } : {}) }

    const [notifications, total, unreadCount] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.notification.count({ where }),
      db.notification.count({ where: { userId, isRead: false } }),
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

  // PATCH /api/notifications/:id/read
  app.patch('/notifications/:id/read', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const notification = await db.notification.findUnique({ where: { id } })
    if (!notification) throw Errors.NOT_FOUND('Notification')
    if (notification.userId !== userId) throw Errors.FORBIDDEN()

    const updated = await db.notification.update({
      where: { id },
      data: { isRead: true },
    })
    return reply.send({ success: true, data: updated })
  })

  // PATCH /api/notifications/read-all
  app.patch('/notifications/read-all', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    await db.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    })
    return reply.send({ success: true })
  })
}
