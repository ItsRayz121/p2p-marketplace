import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { getInbox, getInboxSummary, getThread, postThreadMessage } from '../services/chatThread.service'

const postSchema = z.object({
  body: z.string().max(2000).optional().default(''),
  attachmentUrl: z.string().url().optional(),
})

/**
 * Persistent counterparty messaging inbox (Phase 4). All routes require the
 * `messaging_inbox_enabled` flag; while OFF they return 404 so the feature is
 * fully dark until revealed.
 */
export async function messagingRoutes(app: FastifyInstance) {
  async function assertEnabled() {
    if (!(await isFlagEnabled(FLAGS.MESSAGING_INBOX))) {
      throw new AppError('NOT_FOUND', 'Messaging is not available', 404)
    }
  }

  // GET /api/v1/messages — inbox list
  app.get('/messages', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const data = await getInbox(req.user!.id)
    return reply.send({ success: true, data })
  })

  // GET /api/v1/messages/summary — dropdown badge counts + feature-enabled flag,
  // so the client can reveal the "Messaging" item the moment the flag is flipped.
  app.get('/messages/summary', { preHandler: [authenticate] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.MESSAGING_INBOX))) {
      return reply.send({ success: true, data: { enabled: false, unreadThreads: 0, activeTrades: 0 } })
    }
    const data = await getInboxSummary(req.user!.id)
    return reply.send({ success: true, data: { enabled: true, ...data } })
  })

  // GET /api/v1/messages/:threadId — full thread (messages + episodes + stats)
  app.get('/messages/:threadId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    const data = await getThread(req.user!.id, threadId)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/messages/:threadId — send a message to an established partner
  app.post('/messages/:threadId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    const parsed = postSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const message = await postThreadMessage(req.user!.id, threadId, parsed.data.body, parsed.data.attachmentUrl)
    return reply.code(201).send({ success: true, data: message })
  })
}
