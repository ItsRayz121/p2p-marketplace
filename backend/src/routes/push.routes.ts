import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { env } from '../lib/env'
import { Errors } from '../lib/errors'

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(500).optional(),
})

export async function pushRoutes(app: FastifyInstance) {
  // GET /api/v1/push/vapid-public-key — returns VAPID public key for frontend
  app.get('/push/vapid-public-key', async (_req, reply) => {
    if (!env.VAPID_PUBLIC_KEY) {
      return reply.status(503).send({ success: false, error: 'PUSH_NOT_CONFIGURED', message: 'Push not configured' })
    }
    return reply.send({ success: true, data: { vapidPublicKey: env.VAPID_PUBLIC_KEY } })
  })

  // POST /api/v1/push/subscribe — save or update a push subscription
  app.post('/push/subscribe', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = subscribeSchema.safeParse(req.body)
    if (!parsed.success) throw Errors.VALIDATION_ERROR('Invalid subscription payload')

    const { endpoint, keys, userAgent } = parsed.data
    const userId = req.user!.id

    await db.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint } },
      create: { userId, endpoint, keys, userAgent: userAgent ?? null },
      update: { keys, userAgent: userAgent ?? null },
    })

    return reply.status(201).send({ success: true })
  })

  // DELETE /api/v1/push/unsubscribe — remove a push subscription by endpoint
  app.delete('/push/unsubscribe', { preHandler: [authenticate] }, async (req, reply) => {
    const body = req.body as { endpoint?: string }
    if (!body?.endpoint) throw Errors.VALIDATION_ERROR('endpoint required')

    await db.pushSubscription.deleteMany({
      where: { userId: req.user!.id, endpoint: body.endpoint },
    })

    return reply.send({ success: true })
  })
}
