import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { Errors } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'
import { sseEmit } from '../lib/sse'
import { notify } from '../lib/notify'

// Push a support-chat SSE event to every connected admin / super-admin so the
// admin inbox updates instantly when a user sends a message.
async function emitToAdmins(data: unknown): Promise<void> {
  try {
    const admins = await db.user.findMany({
      where: { role: { in: ['admin', 'super_admin'] } },
      select: { id: true },
    })
    for (const a of admins) sseEmit(a.id, data)
  } catch {
    /* best-effort */
  }
}

const MAX_BODY = 2000

const sendSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY),
})

// Display name priority: fullName > merchant business name > username > email prefix
function displayName(u: { fullName: string | null; username: string | null; email: string }): string {
  if (u.fullName?.trim()) return u.fullName.trim()
  if (u.username?.trim()) return u.username.trim()
  return u.email.split('@')[0] || 'Trader'
}

export async function supportRoutes(app: FastifyInstance) {
  // ─── USER ENDPOINTS ──────────────────────────────────────────────────────

  // GET /support/chat — current user's conversation + messages (polled by widget)
  app.get('/support/chat', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const conversation = await db.supportConversation.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
    })

    if (!conversation) {
      return reply.send({ success: true, data: { conversation: null, messages: [] } })
    }

    return reply.send({
      success: true,
      data: {
        conversation: {
          id: conversation.id,
          status: conversation.status,
          unreadByUser: conversation.unreadByUser,
          lastMessageAt: conversation.lastMessageAt,
        },
        messages: conversation.messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          body: m.body,
          createdAt: m.createdAt,
        })),
      },
    })
  })

  // POST /support/chat/messages — send a message (creates conversation on first send)
  app.post('/support/chat/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { body } = sendSchema.parse(req.body)

    let conversation = await db.supportConversation.findFirst({
      where: { userId, status: 'open' },
      orderBy: { createdAt: 'desc' },
    })
    if (!conversation) {
      conversation = await db.supportConversation.create({ data: { userId } })
    }
    // Was this conversation already awaiting an admin reply? If so, don't fire a
    // second admin notification for rapid follow-up messages.
    const alreadyUnread = conversation.unreadByAdmin

    const message = await db.supportMessage.create({
      data: { conversationId: conversation.id, sender: 'user', senderId: userId, body },
    })
    await db.supportConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadByAdmin: true, status: 'open' },
    })

    // Instant push to any admin viewing the inbox (SSE)
    void emitToAdmins({
      type: 'support_message',
      payload: { scope: 'admin', conversationId: conversation.id, sender: 'user' },
    })

    // Notify admins in the admin panel (only on the first unread message of a thread)
    if (!alreadyUnread) {
      const sender = await db.user.findUnique({
        where: { id: userId },
        select: { fullName: true, username: true, email: true },
      })
      const name = sender ? displayName(sender) : 'A user'
      void createAdminNotif({
        category: 'SYSTEM',
        title: 'New support message',
        body: `${name}: ${body.slice(0, 120)}`,
        href: '/admin/support',
        metadata: { userId, conversationId: conversation.id },
      })
    }

    return reply.send({
      success: true,
      data: { id: message.id, sender: 'user', body: message.body, createdAt: message.createdAt },
    })
  })

  // POST /support/chat/read — user marks admin replies as read
  app.post('/support/chat/read', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    await db.supportConversation.updateMany({
      where: { userId, unreadByUser: true },
      data: { unreadByUser: false },
    })
    return reply.send({ success: true })
  })

  // ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────

  // GET /admin/support/conversations — inbox list
  app.get(
    '/admin/support/conversations',
    { preHandler: [authenticate, requireRole('admin', 'super_admin')] },
    async (_req, reply) => {
      const conversations = await db.supportConversation.findMany({
        orderBy: [{ unreadByAdmin: 'desc' }, { lastMessageAt: 'desc' }],
        take: 200,
        include: {
          user: { select: { id: true, fullName: true, username: true, email: true, avatarUrl: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      })

      return reply.send({
        success: true,
        data: conversations.map((c) => ({
          id: c.id,
          status: c.status,
          unreadByAdmin: c.unreadByAdmin,
          lastMessageAt: c.lastMessageAt,
          lastMessage: c.messages[0]?.body ?? null,
          user: {
            id: c.user.id,
            name: displayName(c.user),
            avatarUrl: c.user.avatarUrl,
          },
        })),
      })
    },
  )

  // GET /admin/support/conversations/:id — full thread (marks read for admin)
  app.get(
    '/admin/support/conversations/:id',
    { preHandler: [authenticate, requireRole('admin', 'super_admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const conversation = await db.supportConversation.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, fullName: true, username: true, email: true, avatarUrl: true } },
          messages: { orderBy: { createdAt: 'asc' }, take: 500 },
        },
      })
      if (!conversation) throw Errors.NOT_FOUND('Conversation')

      if (conversation.unreadByAdmin) {
        await db.supportConversation.update({ where: { id }, data: { unreadByAdmin: false } })
      }

      return reply.send({
        success: true,
        data: {
          id: conversation.id,
          status: conversation.status,
          user: {
            id: conversation.user.id,
            name: displayName(conversation.user),
            email: conversation.user.email,
            avatarUrl: conversation.user.avatarUrl,
          },
          messages: conversation.messages.map((m) => ({
            id: m.id,
            sender: m.sender,
            body: m.body,
            createdAt: m.createdAt,
          })),
        },
      })
    },
  )

  // POST /admin/support/conversations/:id/messages — admin reply
  app.post(
    '/admin/support/conversations/:id/messages',
    { preHandler: [authenticate, requireRole('admin', 'super_admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { body } = sendSchema.parse(req.body)

      const conversation = await db.supportConversation.findUnique({ where: { id } })
      if (!conversation) throw Errors.NOT_FOUND('Conversation')

      const message = await db.supportMessage.create({
        data: { conversationId: id, sender: 'admin', senderId: req.user!.id, body },
      })
      await db.supportConversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), unreadByUser: true, unreadByAdmin: false },
      })

      // Instant push to the user's chat widget (SSE)
      sseEmit(conversation.userId, {
        type: 'support_message',
        payload: {
          scope: 'user',
          conversationId: id,
          message: { id: message.id, sender: 'admin', body: message.body, createdAt: message.createdAt },
        },
      })

      // Persistent bell notification + web-push so the user notices even with the widget closed
      notify(
        conversation.userId,
        'support',
        'New reply from Support',
        body.slice(0, 140),
        { conversationId: id },
      )

      return reply.send({
        success: true,
        data: { id: message.id, sender: 'admin', body: message.body, createdAt: message.createdAt },
      })
    },
  )

  // POST /admin/support/conversations/:id/close
  app.post(
    '/admin/support/conversations/:id/close',
    { preHandler: [authenticate, requireRole('admin', 'super_admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      await db.supportConversation.update({ where: { id }, data: { status: 'closed' } })
      return reply.send({ success: true })
    },
  )
}
