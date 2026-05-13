import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'

const createAlertSchema = z.object({
  coin: z.string().min(1).max(20),
  targetRate: z.number().positive(),
  direction: z.enum(['above', 'below']),
  network: z.string().min(1).max(50).optional().default(''),
})

export async function rateAlertRoutes(app: FastifyInstance) {
  // GET /api/rate-alerts
  app.get('/rate-alerts', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const alerts = await db.rateAlert.findMany({
      where: { userId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ success: true, data: alerts })
  })

  // POST /api/rate-alerts
  app.post('/rate-alerts', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = createAlertSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    // Check alert limit per user
    const activeCount = await db.rateAlert.count({
      where: { userId, status: 'active' },
    })
    if (activeCount >= 20) {
      throw new AppError('ALERT_LIMIT_EXCEEDED', 'Maximum 20 active rate alerts allowed', 400)
    }

    const alert = await db.rateAlert.create({
      data: {
        userId,
        coin: parsed.data.coin,
        network: parsed.data.network,
        targetRate: parsed.data.targetRate,
        direction: parsed.data.direction,
        status: 'active',
      },
    })
    return reply.code(201).send({ success: true, data: alert })
  })

  // DELETE /api/rate-alerts/:id
  app.delete('/rate-alerts/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const alert = await db.rateAlert.findUnique({ where: { id } })
    if (!alert) throw Errors.NOT_FOUND('Rate alert')
    if (alert.userId !== userId) throw Errors.FORBIDDEN()

    await db.rateAlert.delete({ where: { id } })
    return reply.send({ success: true })
  })
}
