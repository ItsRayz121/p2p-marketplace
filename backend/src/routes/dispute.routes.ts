import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'

const messageSchema = z.object({
  message: z.string().min(1).max(2000),
  attachmentUrl: z.string().url().optional(),
})

export async function disputeRoutes(app: FastifyInstance) {
  // GET /api/disputes — list user's disputes
  app.get('/disputes', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const query = req.query as Record<string, string>
    const page = query.page ? parseInt(query.page, 10) : 1
    const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
    const skip = (page - 1) * limit

    const where = {
      OR: [
        { openedById: userId },
        { trade: { buyerId: userId } },
        { trade: { sellerId: userId } },
      ],
    }

    const [disputes, total] = await Promise.all([
      db.dispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          trade: {
            select: {
              orderRef: true,
              coin: true,
              amount: true,
              fiatAmount: true,
              status: true,
              buyer: { select: { username: true } },
              seller: { select: { username: true } },
            },
          },
          _count: { select: { messages: true } },
        },
      }),
      db.dispute.count({ where }),
    ])

    return reply.send({
      success: true,
      data: {
        disputes,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })

  // GET /api/disputes/:id
  app.get('/disputes/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const dispute = await db.dispute.findUnique({
      where: { id },
      include: {
        trade: {
          include: {
            buyer: { select: { id: true, username: true } },
            seller: { select: { id: true, username: true } },
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')

    // Verify access: must be trade buyer, seller, or opener
    const hasAccess =
      dispute.openedById === userId ||
      dispute.trade.buyerId === userId ||
      dispute.trade.sellerId === userId ||
      ['admin', 'super_admin', 'dispute_agent'].includes(req.user!.role)

    if (!hasAccess) throw Errors.FORBIDDEN()

    return reply.send({ success: true, data: dispute })
  })

  // POST /api/disputes/:id/messages
  app.post('/disputes/:id/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const dispute = await db.dispute.findUnique({
      where: { id },
      include: { trade: { select: { buyerId: true, sellerId: true } } },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')

    const hasAccess =
      dispute.openedById === userId ||
      dispute.trade.buyerId === userId ||
      dispute.trade.sellerId === userId ||
      ['admin', 'super_admin', 'dispute_agent'].includes(req.user!.role)

    if (!hasAccess) throw Errors.FORBIDDEN()

    if (dispute.status === 'resolved') {
      throw new AppError('DISPUTE_RESOLVED', 'Cannot add messages to a resolved dispute', 400)
    }

    const message = await db.disputeMessage.create({
      data: {
        disputeId: id,
        senderId: userId,
        message: parsed.data.message,
        evidenceUrl: parsed.data.attachmentUrl ?? null,
      },
    })

    return reply.code(201).send({ success: true, data: message })
  })
}
