import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { db } from '../lib/prisma'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { createAdminNotif } from '../services/adminNotification.service'
import {
  getInbox, getInboxSummary, getThread, postThreadMessage, deleteThreadMessage,
  searchUsers, startThread, getOrCreateSelfThread, blockThreadUser, unblockThreadUser,
} from '../services/chatThread.service'

const postSchema = z.object({
  body: z.string().max(2000).optional().default(''),
  attachmentUrl: z.string().url().optional(),
  // Client-generated key for send-retry idempotency (see postThreadMessage).
  clientId: z.string().min(1).max(64).optional(),
  // One-tap "share my listing" — both present or both absent.
  sharedAdMarket: z.enum(['usdt', 'ctm']).optional(),
  sharedAdId: z.string().min(1).max(64).optional(),
})

const startSchema = z.object({ username: z.string().trim().min(1).max(30) })
const reportSchema = z.object({ reason: z.string().trim().min(1).max(1000) })

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

  // GET /api/v1/messages/:threadId — full thread (messages + episodes + stats).
  // ?markRead=0 skips marking the counterparty's messages read (used for the
  // frontend's background poll while the tab isn't actually visible) — delivery
  // is unaffected, only the "seen by a human" read receipt.
  app.get('/messages/:threadId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    const markRead = (req.query as { markRead?: string }).markRead !== '0'
    const data = await getThread(req.user!.id, threadId, markRead)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/messages/:threadId — send a message to an established partner
  app.post('/messages/:threadId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    const parsed = postSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const sharedAd = parsed.data.sharedAdMarket && parsed.data.sharedAdId
      ? { market: parsed.data.sharedAdMarket, id: parsed.data.sharedAdId }
      : undefined
    const message = await postThreadMessage(req.user!.id, threadId, parsed.data.body, parsed.data.attachmentUrl, parsed.data.clientId, sharedAd)
    return reply.code(201).send({ success: true, data: message })
  })

  // POST /api/v1/messages/:threadId/:messageId/delete — retract your own message
  app.post('/messages/:threadId/:messageId/delete', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId, messageId } = req.params as { threadId: string; messageId: string }
    const data = await deleteThreadMessage(req.user!.id, threadId, messageId)
    return reply.send({ success: true, data })
  })

  // GET /api/v1/messages/search?q=... — find a person by username to start a
  // NEW conversation (no shared trade required; BlockedUser is the safety valve).
  app.get('/messages/search', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const q = (req.query as { q?: string }).q ?? ''
    const data = await searchUsers(req.user!.id, q)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/messages/start — get-or-create a thread with a user by username
  app.post('/messages/start', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { username } = startSchema.parse(req.body)
    const data = await startThread(req.user!.id, username)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/messages/self — get-or-create the viewer's own "My Notes"
  // private-notes thread. The only path into a self-thread (search and
  // /messages/start both refuse a self-target).
  app.post('/messages/self', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const data = await getOrCreateSelfThread(req.user!.id)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/messages/:threadId/block — block the other participant
  app.post('/messages/:threadId/block', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    await blockThreadUser(req.user!.id, threadId)
    return reply.send({ success: true, data: { blocked: true } })
  })

  // POST /api/v1/messages/:threadId/unblock
  app.post('/messages/:threadId/unblock', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    await unblockThreadUser(req.user!.id, threadId)
    return reply.send({ success: true, data: { blocked: false } })
  })

  // POST /api/v1/messages/:threadId/report — file a report about the other
  // participant. Routed into the reporter's own Support conversation (existing,
  // admin-monitored inbox) rather than a new dead-end table, so it's actually
  // seen. Never exposes the report to the other participant.
  app.post('/messages/:threadId/report', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { threadId } = req.params as { threadId: string }
    const { reason } = reportSchema.parse(req.body)
    const thread = await db.chatThread.findUnique({
      where: { id: threadId },
      select: {
        userAId: true, userBId: true,
        userA: { select: { username: true } },
        userB: { select: { username: true } },
      },
    })
    if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
    const userId = req.user!.id
    if (thread.userAId !== userId && thread.userBId !== userId) {
      throw new AppError('FORBIDDEN', 'Not a participant of this conversation', 403)
    }
    // The self-notes thread has no "other" side to report — the frontend never
    // shows a report control for it (see isSelf in the thread page).
    if (thread.userAId === thread.userBId) throw new AppError('VALIDATION_ERROR', "You can't report yourself", 400)
    const reportedUsername = thread.userAId === userId ? thread.userB.username : thread.userA.username

    let conversation = await db.supportConversation.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (!conversation) conversation = await db.supportConversation.create({ data: { userId } })
    const body = `⚠️ Reporting @${reportedUsername} (conversation ${threadId}): ${reason}`
    await db.supportMessage.create({ data: { conversationId: conversation.id, sender: 'user', senderId: userId, body } })
    await db.supportConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadByAdmin: true, status: 'open' },
    })
    void createAdminNotif({
      category: 'SYSTEM',
      title: 'User report filed',
      body: `A user reported @${reportedUsername} from a direct conversation: ${reason.slice(0, 120)}`,
      href: '/admin/support',
      metadata: { userId, reportedUsername, threadId },
      roles: ['support_agent', 'admin', 'super_admin'],
      telegram: true,
    })
    return reply.send({ success: true, data: { filed: true } })
  })
}
