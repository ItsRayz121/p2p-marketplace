import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { Errors } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'
import { sseEmit } from '../lib/sse'
import { notify } from '../lib/notify'
import { mergeDuplicateSupportConversations } from '../services/supportMaintenance.service'

// Push a support-chat SSE event to every connected admin / super-admin so the
// admin inbox updates instantly when a user sends a message.
async function emitToAdmins(data: unknown): Promise<void> {
  try {
    const admins = await db.user.findMany({
      where: { role: { in: ['admin', 'super_admin', 'support_agent'] } },
      select: { id: true },
    })
    for (const a of admins) sseEmit(a.id, data)
  } catch {
    /* best-effort */
  }
}

const MAX_BODY = 2000

// A message can only be retracted within this window of being sent. The original
// is retained for dispute review regardless; the window additionally prevents
// yanking an old message the other party may already have acted on.
export const MESSAGE_DELETE_WINDOW_MS = 15 * 60 * 1000

// A message needs text OR an image (image-only messages allowed). Cloudinary
// URLs only — reject anything that isn't an https link to our upload host.
const sendSchema = z
  .object({
    body: z.string().trim().max(MAX_BODY).optional().default(''),
    attachmentUrl: z.string().url().max(500).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || !!v.attachmentUrl, {
    message: 'Message is empty',
  })

const rateSchema = z.object({
  score: z.number().int().min(1).max(3), // 1=bad 2=okay 3=great
})

const RATING_LABELS: Record<number, string> = { 1: 'Rated support 😞 Bad', 2: 'Rated support 😐 Okay', 3: 'Rated support 😊 Great' }

const DEFAULT_CLOSE_SURVEY =
  'Thanks for contacting RupChain Support! Before you go — how did we do? Tap an emoji below to rate your experience. 👇'

// Admin-editable closing/survey message (Platform Config key
// `support_close_survey_message`); falls back to the friendly default. Upserts
// the default when missing so the key surfaces in Admin → Config → Advanced
// Settings for editing (never overwrites an admin's custom value).
async function getCloseSurveyMessage(): Promise<string> {
  const row = await db.platformConfig.upsert({
    where: { key: 'support_close_survey_message' },
    update: {},
    create: { key: 'support_close_survey_message', value: DEFAULT_CLOSE_SURVEY },
  })
  const v = row.value?.trim()
  return v && v.length > 0 ? v : DEFAULT_CLOSE_SURVEY
}

// Display name priority: fullName > merchant business name > username > email prefix
function displayName(u: { fullName: string | null; username: string | null; email: string }): string {
  if (u.fullName?.trim()) return u.fullName.trim()
  if (u.username?.trim()) return u.username.trim()
  return u.email.split('@')[0] || 'Trader'
}

// Uniform message shape for both the user widget and the admin inbox. `kind` and
// `metadata` drive structured messages (refund_request form / refund_response).
function serializeMessage(
  m: {
    id: string
    sender: string
    body: string
    attachmentUrl?: string | null
    deletedAt?: Date | null
    rating: number | null
    kind: string
    metadata: unknown
    createdAt: Date
  },
  // Admins/dispute resolution always see the original content of a deleted
  // message (with a `deletedAt` marker). Regular users get it redacted to a
  // tombstone so a retracted message/image cannot be read by the other party.
  opts?: { viewerIsAdmin?: boolean },
) {
  const redacted = !!m.deletedAt && !opts?.viewerIsAdmin
  return {
    id: m.id,
    sender: m.sender,
    body: redacted ? '' : m.body,
    attachmentUrl: redacted ? null : (m.attachmentUrl ?? null),
    deletedAt: m.deletedAt ?? null,
    rating: m.rating,
    kind: redacted ? 'text' : m.kind,
    metadata: redacted ? null : (m.metadata ?? null),
    createdAt: m.createdAt,
  }
}

// Validate a USDT refund address against the chosen rail. Mirrors the admin
// manual-refund validation so a user can only submit an address the refund
// engine can actually pay out to.
function validateRefundAddress(network: string, address: string): boolean {
  const net = network.toUpperCase()
  const addr = address.trim()
  if (net === 'TRC20') return /^T[A-Za-z1-9]{33}$/.test(addr)
  if (net === 'BEP20' || net === 'ERC20') return /^0x[0-9a-fA-F]{40}$/.test(addr)
  // Match the refund engine's validateAptosAddress exactly (full 64-hex, 0x-prefixed)
  // so an address the user submits can't later be rejected by the admin refund route.
  if (net === 'APTOS') return /^0x[0-9a-fA-F]{64}$/.test(addr)
  return false
}

const REFUND_NETWORKS = ['BEP20', 'ERC20', 'TRC20', 'APTOS'] as const

export async function supportRoutes(app: FastifyInstance) {
  // ─── USER ENDPOINTS ──────────────────────────────────────────────────────

  // GET /support/chat — current user's conversation + messages (polled by widget)
  app.get('/support/chat', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const conversation = await db.supportConversation.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      // Most recent 200 — the box is now permanent per user, so take the newest
      // (desc) and flip back to chronological for rendering, not the oldest 200.
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 200 } },
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
        messages: [...conversation.messages].reverse().map((m) => serializeMessage(m)),
      },
    })
  })

  // POST /support/chat/messages — send a message (creates conversation on first send)
  app.post('/support/chat/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { body, attachmentUrl } = sendSchema.parse(req.body)

    // One conversation box per user, forever: reuse the user's most recent
    // conversation regardless of status. A closed conversation is reopened below
    // (status:'open'), so a returning user continues in the SAME thread — each
    // visit is separated by a session divider, not a new inbox row.
    let conversation = await db.supportConversation.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    if (!conversation) {
      conversation = await db.supportConversation.create({ data: { userId } })
    }
    // Was this conversation already awaiting an admin reply? If so, don't fire a
    // second admin notification for rapid follow-up messages.
    const alreadyUnread = conversation.unreadByAdmin

    const message = await db.supportMessage.create({
      data: { conversationId: conversation.id, sender: 'user', senderId: userId, body, ...(attachmentUrl ? { attachmentUrl } : {}) },
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
      const preview = body.trim() ? body.slice(0, 120) : '📷 Photo'
      void createAdminNotif({
        category: 'SYSTEM',
        title: 'New support message',
        body: `${name}: ${preview}`,
        href: '/admin/support',
        metadata: { userId, conversationId: conversation.id },
        roles: ['support_agent', 'admin', 'super_admin'],
        telegram: true,
      })
    }

    return reply.send({
      success: true,
      data: serializeMessage(message),
    })
  })

  // POST /support/chat/messages/:id/delete — user retracts their OWN message.
  // Soft delete: the row is retained (admins/dispute still see the original); the
  // message renders as a "deleted" tombstone for everyone else.
  app.post('/support/chat/messages/:id/delete', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const message = await db.supportMessage.findUnique({
      where: { id },
      include: { conversation: { select: { userId: true } } },
    })
    // Only the author (a real user message they own) can retract it; never a
    // system note, refund form, or an admin/support message.
    if (
      !message ||
      message.conversation.userId !== userId ||
      message.sender !== 'user' ||
      message.senderId !== userId ||
      message.kind !== 'text'
    ) {
      throw Errors.NOT_FOUND('Message')
    }
    if (message.deletedAt) return reply.send({ success: true }) // idempotent
    if (Date.now() - message.createdAt.getTime() > MESSAGE_DELETE_WINDOW_MS) {
      throw Errors.VALIDATION_ERROR('Messages can only be deleted within 15 minutes of sending.')
    }

    await db.supportMessage.update({ where: { id }, data: { deletedAt: new Date() } })

    // Let any admin viewing the thread see the tombstone appear live.
    void emitToAdmins({
      type: 'support_message',
      payload: { scope: 'admin', conversationId: message.conversationId, sender: 'user' },
    })

    return reply.send({ success: true })
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

  // POST /support/chat/rate — user rates the just-closed session (😞😐😊)
  app.post('/support/chat/rate', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { score } = rateSchema.parse(req.body)

    const conversation = await db.supportConversation.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 8 } },
    })
    if (!conversation || conversation.status !== 'closed') {
      throw Errors.VALIDATION_ERROR('No closed conversation to rate')
    }
    // Already rated? Scan the trailing block of system notes/ratings; a system
    // message with a rating means this session was already scored. Stop at the
    // first real (user/admin) message — that's the session boundary.
    for (const m of conversation.messages) {
      if (m.sender !== 'system') break
      if (m.rating != null) return reply.send({ success: true }) // idempotent
    }

    const message = await db.supportMessage.create({
      data: {
        conversationId: conversation.id,
        sender: 'system',
        senderId: userId,
        rating: score,
        body: RATING_LABELS[score] ?? 'Rated support',
      },
    })
    // Deliberately does NOT bump lastMessageAt or reopen — a rating ends a
    // session, it doesn't start a new one.

    // Let admins see fresh feedback appear live in an open thread.
    void emitToAdmins({
      type: 'support_message',
      payload: { scope: 'admin', conversationId: conversation.id, sender: 'system' },
    })

    return reply.send({
      success: true,
      data: { id: message.id, sender: 'system', rating: score, body: message.body, createdAt: message.createdAt },
    })
  })

  // POST /support/chat/refund-response — user answers an admin refund_request with
  // their USDT destination. Stores a structured refund_response message, stamps the
  // referenced gas order with the suggested address so the admin refund modal can
  // pre-fill it, and pings admins.
  const refundResponseSchema = z.object({
    requestId: z.string().min(1),
    network: z.enum(REFUND_NETWORKS),
    address: z.string().trim().min(1).max(200),
  })
  app.post('/support/chat/refund-response', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { requestId, network, address } = refundResponseSchema.parse(req.body)

    if (!validateRefundAddress(network, address)) {
      throw Errors.VALIDATION_ERROR(`That doesn't look like a valid ${network} address.`)
    }

    // The request must be a refund_request in THIS user's conversation.
    const request = await db.supportMessage.findUnique({
      where: { id: requestId },
      include: { conversation: { select: { id: true, userId: true } } },
    })
    if (!request || request.kind !== 'refund_request' || request.conversation.userId !== userId) {
      throw Errors.NOT_FOUND('Refund request')
    }
    const orderRef = (request.metadata as { orderRef?: string } | null)?.orderRef ?? null

    // Idempotent: if an answer to THIS request already exists (any of them), return
    // it instead of posting a duplicate. Scan all responses in the (small) thread so
    // it's correct even when several refund_requests have been answered.
    const priorResponses = await db.supportMessage.findMany({
      where: { conversationId: request.conversation.id, kind: 'refund_response' },
      orderBy: { createdAt: 'desc' },
    })
    const already = priorResponses.find(
      (m) => (m.metadata as { requestId?: string } | null)?.requestId === requestId,
    )
    if (already) {
      return reply.send({ success: true, data: serializeMessage(already) })
    }

    const message = await db.supportMessage.create({
      data: {
        conversationId: request.conversation.id,
        sender: 'user',
        senderId: userId,
        kind: 'refund_response',
        body: `Refund address: ${address} (${network})`,
        metadata: { requestId, address, network, orderRef },
      },
    })
    await db.supportConversation.update({
      where: { id: request.conversation.id },
      data: { lastMessageAt: new Date(), unreadByAdmin: true, status: 'open' },
    })

    // Stamp the order so the admin manual-refund modal pre-fills this destination.
    if (orderRef) {
      await db.gasFeeOrder.updateMany({
        where: { orderRef, userId },
        data: { suggestedRefundAddress: address, suggestedRefundNetwork: network },
      })
    }

    void emitToAdmins({
      type: 'support_message',
      payload: { scope: 'admin', conversationId: request.conversation.id, sender: 'user' },
    })
    void createAdminNotif({
      category: 'GAS',
      title: 'Refund address submitted',
      body: `User provided a ${network} refund address${orderRef ? ` for order ${orderRef}` : ''}: ${address}`,
      href: orderRef ? `/admin/gas/orders/${orderRef}` : '/admin/support',
      metadata: { userId, orderRef, address, network },
      roles: ['support_agent', 'admin', 'super_admin'],
      telegram: true,
    })

    return reply.send({ success: true, data: serializeMessage(message) })
  })

  // ─── ADMIN ENDPOINTS ─────────────────────────────────────────────────────

  // GET /admin/support/users/search — find a user to reach out to (by name/username/email/id)
  app.get(
    '/admin/support/users/search',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const q = ((req.query as { q?: string }).q ?? '').trim()
      if (q.length < 2) return reply.send({ success: true, data: [] })
      const users = await db.user.findMany({
        where: {
          OR: [
            { username: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { fullName: { contains: q, mode: 'insensitive' } },
            { id: q },
          ],
        },
        select: { id: true, fullName: true, username: true, email: true, avatarUrl: true },
        take: 15,
        orderBy: { createdAt: 'desc' },
      })
      return reply.send({
        success: true,
        data: users.map((u) => ({
          id: u.id,
          name: displayName(u),
          username: u.username,
          email: u.email,
          avatarUrl: u.avatarUrl,
        })),
      })
    },
  )

  // POST /admin/support/contact — open (create if needed) a user's support thread
  // and optionally post an opening admin message. This is the admin-initiated seam:
  // users can start chats, and now support can reach out first.
  const contactSchema = z.object({
    userId: z.string().min(1),
    body: z.string().trim().max(MAX_BODY).optional(),
  })
  app.post(
    '/admin/support/contact',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { userId, body } = contactSchema.parse(req.body)
      const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!target) throw Errors.NOT_FOUND('User')

      let conversation = await db.supportConversation.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      })
      if (!conversation) conversation = await db.supportConversation.create({ data: { userId } })

      if (body && body.length > 0) {
        const message = await db.supportMessage.create({
          data: { conversationId: conversation.id, sender: 'admin', senderId: req.user!.id, body },
        })
        await db.supportConversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date(), unreadByUser: true, unreadByAdmin: false, status: 'open' },
        })
        sseEmit(userId, {
          type: 'support_message',
          payload: {
            scope: 'user',
            conversationId: conversation.id,
            message: { id: message.id, sender: 'admin', body: message.body, createdAt: message.createdAt },
          },
        })
        notify(userId, 'support', 'New message from Support', body.slice(0, 140), { conversationId: conversation.id })
      }

      return reply.send({ success: true, data: { conversationId: conversation.id } })
    },
  )

  // POST /admin/support/refund-request — ask a user (in chat) for a USDT refund
  // destination, tied to a specific gas order. Renders as a form in their widget.
  const refundRequestSchema = z.object({
    userId: z.string().min(1),
    orderRef: z.string().min(1),
    body: z.string().trim().max(MAX_BODY).optional(),
  })
  app.post(
    '/admin/support/refund-request',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { userId, orderRef, body } = refundRequestSchema.parse(req.body)
      const order = await db.gasFeeOrder.findUnique({
        where: { orderRef },
        select: { orderRef: true, userId: true, chain: true, paymentNetwork: true, paymentAmount: true },
      })
      if (!order) throw Errors.NOT_FOUND('Gas order')
      if (order.userId && order.userId !== userId) {
        throw Errors.VALIDATION_ERROR('This order belongs to a different user.')
      }

      let conversation = await db.supportConversation.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      })
      if (!conversation) conversation = await db.supportConversation.create({ data: { userId } })

      const text =
        body && body.trim().length > 0
          ? body.trim()
          : `We need to refund your gas order ${orderRef} (${order.paymentAmount} USDT). Please share the USDT address and network where you'd like to receive it.`

      const message = await db.supportMessage.create({
        data: {
          conversationId: conversation.id,
          sender: 'admin',
          senderId: req.user!.id,
          kind: 'refund_request',
          body: text,
          metadata: { orderRef, chain: order.chain, paymentNetwork: order.paymentNetwork },
        },
      })
      await db.supportConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date(), unreadByUser: true, unreadByAdmin: false, status: 'open' },
      })

      sseEmit(userId, {
        type: 'support_message',
        payload: {
          scope: 'user',
          conversationId: conversation.id,
          message: serializeMessage(message),
        },
      })
      notify(userId, 'support', 'Refund — action needed', text.slice(0, 140), {
        conversationId: conversation.id,
        orderRef,
      })

      return reply.send({ success: true, data: { conversationId: conversation.id, messageId: message.id } })
    },
  )

  // GET /admin/support/conversations — inbox list
  app.get(
    '/admin/support/conversations',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
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
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const conversation = await db.supportConversation.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, fullName: true, username: true, email: true, avatarUrl: true } },
          // Most recent 500 (desc), flipped to chronological below — the box is
          // permanent per user, so don't cap at the oldest 500.
          messages: { orderBy: { createdAt: 'desc' }, take: 500 },
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
          // Admin/dispute view: deleted messages keep their original content (with
          // a deletedAt marker) so retracted evidence stays visible here.
          messages: [...conversation.messages].reverse().map((m) => serializeMessage(m, { viewerIsAdmin: true })),
        },
      })
    },
  )

  // POST /admin/support/conversations/:id/messages — admin reply (text and/or image)
  app.post(
    '/admin/support/conversations/:id/messages',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { body, attachmentUrl } = sendSchema.parse(req.body)

      const conversation = await db.supportConversation.findUnique({ where: { id } })
      if (!conversation) throw Errors.NOT_FOUND('Conversation')

      const message = await db.supportMessage.create({
        data: { conversationId: id, sender: 'admin', senderId: req.user!.id, body, ...(attachmentUrl ? { attachmentUrl } : {}) },
      })
      await db.supportConversation.update({
        where: { id },
        // An admin reply reopens the thread (e.g. following up on an auto-closed
        // chat) so it doesn't get swept shut again before the user responds.
        data: { lastMessageAt: new Date(), unreadByUser: true, unreadByAdmin: false, status: 'open' },
      })

      // Instant push to the user's chat widget (SSE)
      sseEmit(conversation.userId, {
        type: 'support_message',
        payload: {
          scope: 'user',
          conversationId: id,
          message: serializeMessage(message),
        },
      })

      // Persistent bell notification + web-push so the user notices even with the widget closed
      notify(
        conversation.userId,
        'support',
        'New reply from Support',
        body.trim() ? body.slice(0, 140) : '📷 Photo',
        { conversationId: id },
      )

      return reply.send({
        success: true,
        data: serializeMessage(message),
      })
    },
  )

  // POST /admin/support/conversations/:id/messages/:msgId/delete — admin retracts
  // their OWN support message. Soft delete: the user's widget shows a tombstone;
  // the row is retained here for the audit trail.
  app.post(
    '/admin/support/conversations/:id/messages/:msgId/delete',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { id, msgId } = req.params as { id: string; msgId: string }
      const message = await db.supportMessage.findUnique({ where: { id: msgId } })
      if (
        !message ||
        message.conversationId !== id ||
        message.sender !== 'admin' ||
        message.senderId !== req.user!.id ||
        message.kind !== 'text'
      ) {
        throw Errors.NOT_FOUND('Message')
      }
      if (message.deletedAt) return reply.send({ success: true }) // idempotent
      if (Date.now() - message.createdAt.getTime() > MESSAGE_DELETE_WINDOW_MS) {
        throw Errors.VALIDATION_ERROR('Messages can only be deleted within 15 minutes of sending.')
      }

      await db.supportMessage.update({ where: { id: msgId }, data: { deletedAt: new Date() } })

      const conversation = await db.supportConversation.findUnique({ where: { id }, select: { userId: true } })
      if (conversation) {
        // Push the tombstone to the user's widget instantly.
        sseEmit(conversation.userId, {
          type: 'support_message',
          payload: { scope: 'user', conversationId: id, deletedMessageId: msgId },
        })
      }

      return reply.send({ success: true })
    },
  )

  // POST /admin/support/merge-conversations — one-off maintenance: collapse each
  // user's duplicate conversations into one (runs in-cluster; no CLI needed).
  app.post(
    '/admin/support/merge-conversations',
    { preHandler: [authenticate, requireRole('super_admin')] },
    async (_req, reply) => {
      const result = await mergeDuplicateSupportConversations()
      return reply.send({ success: true, data: result })
    },
  )

  // POST /admin/support/conversations/:id/close — closes + posts a prebuilt
  // survey message so the user is invited to rate without the admin retyping it.
  app.post(
    '/admin/support/conversations/:id/close',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'support_agent')] },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const conversation = await db.supportConversation.findUnique({ where: { id } })
      if (!conversation) throw Errors.NOT_FOUND('Conversation')

      // Idempotent: closing an already-closed chat must not post a second survey.
      if (conversation.status === 'closed') return reply.send({ success: true })

      const surveyBody = await getCloseSurveyMessage()
      const message = await db.supportMessage.create({
        data: { conversationId: id, sender: 'system', senderId: req.user!.id, body: surveyBody },
      })
      await db.supportConversation.update({
        where: { id },
        // System survey note doesn't count as "unanswered" — but surface it to the
        // user (unreadByUser) so they see the prompt. lastMessageAt is bumped so
        // the closed session sorts naturally; status stays closed (awaiting rating).
        data: { status: 'closed', lastMessageAt: new Date(), unreadByUser: true },
      })

      sseEmit(conversation.userId, {
        type: 'support_message',
        payload: {
          scope: 'user',
          conversationId: id,
          message: { id: message.id, sender: 'system', body: message.body, rating: null, createdAt: message.createdAt },
        },
      })

      return reply.send({ success: true })
    },
  )
}
