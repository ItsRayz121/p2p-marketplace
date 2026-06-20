import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'

const createSchema = z.object({
  label: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(2000),
})

export async function savedTermsRoutes(app: FastifyInstance) {
  // GET /api/v1/saved-terms — the user's reusable terms templates
  app.get('/saved-terms', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const items = await db.savedTerms.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return reply.send({ success: true, data: items })
  })

  // POST /api/v1/saved-terms — save a new terms template
  app.post('/saved-terms', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const count = await db.savedTerms.count({ where: { userId } })
    if (count >= 20) {
      throw new AppError('TERMS_LIMIT_EXCEEDED', 'Maximum 20 saved terms templates allowed', 400)
    }

    const item = await db.savedTerms.create({
      data: { userId, label: parsed.data.label, body: parsed.data.body },
    })
    return reply.code(201).send({ success: true, data: item })
  })

  // DELETE /api/v1/saved-terms/:id
  app.delete('/saved-terms/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const item = await db.savedTerms.findUnique({ where: { id } })
    if (!item) throw Errors.NOT_FOUND('Saved terms')
    if (item.userId !== userId) throw Errors.FORBIDDEN()

    await db.savedTerms.delete({ where: { id } })
    return reply.send({ success: true })
  })
}
