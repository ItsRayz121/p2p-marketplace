import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import {
  listMyChannels, searchChannelDirectory, createChannel, getChannel, listChannelMessages,
  joinChannel, leaveChannel, updateChannel, regenerateInvite, deleteChannel, kickMember,
  listMembers, postChannelMessage, deleteChannelMessage, editChannelMessage,
} from '../services/channel.service'

const createSchema = z.object({
  name: z.string().trim().min(3).max(60),
  description: z.string().trim().max(300).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
})
const updateSchema = z.object({
  name: z.string().trim().min(3).max(60).optional(),
  description: z.string().trim().max(300).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  avatarUrl: z.string().url().max(500).optional(),
})
const postSchema = z.object({
  body: z.string().max(4000).optional().default(''),
  clientId: z.string().min(1).max(64).optional(),
  sharedAdMarket: z.enum(['usdt', 'ctm']).optional(),
  sharedAdId: z.string().min(1).max(64).optional(),
  attachmentUrl: z.string().url().max(500).optional(),
})
const editSchema = z.object({
  body: z.string().trim().min(1).max(4000),
})

/** Telegram-style broadcast Channels tab — see channel.service.ts for the model. */
export async function channelRoutes(app: FastifyInstance) {
  async function assertEnabled() {
    if (!(await isFlagEnabled(FLAGS.CHANNELS, true))) {
      throw new AppError('NOT_FOUND', 'Channels are not available', 404)
    }
  }

  app.get('/channels', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const data = await listMyChannels(req.user!.id)
    return reply.send({ success: true, data })
  })

  app.get('/channels/directory', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const q = (req.query as { q?: string }).q ?? ''
    const data = await searchChannelDirectory(req.user!.id, q)
    return reply.send({ success: true, data })
  })

  app.post('/channels', { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    await assertEnabled()
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await createChannel(req.user!.id, parsed.data)
    return reply.code(201).send({ success: true, data })
  })

  app.get('/channels/:idOrSlug', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { idOrSlug } = req.params as { idOrSlug: string }
    const data = await getChannel(req.user!.id, idOrSlug)
    return reply.send({ success: true, data })
  })

  app.get('/channels/:channelId/messages', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    const data = await listChannelMessages(req.user!.id, channelId)
    return reply.send({ success: true, data })
  })

  app.post('/channels/:channelId/messages', { preHandler: [authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    const parsed = postSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const sharedAd = parsed.data.sharedAdMarket && parsed.data.sharedAdId
      ? { market: parsed.data.sharedAdMarket, id: parsed.data.sharedAdId }
      : undefined
    const message = await postChannelMessage(req.user!.id, channelId, parsed.data.body, parsed.data.clientId, sharedAd, parsed.data.attachmentUrl)
    return reply.code(201).send({ success: true, data: message })
  })

  app.post('/channels/:channelId/messages/:messageId/delete', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId, messageId } = req.params as { channelId: string; messageId: string }
    const data = await deleteChannelMessage(req.user!.id, channelId, messageId)
    return reply.send({ success: true, data })
  })

  app.patch('/channels/:channelId/messages/:messageId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId, messageId } = req.params as { channelId: string; messageId: string }
    const parsed = editSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await editChannelMessage(req.user!.id, channelId, messageId, parsed.data.body)
    return reply.send({ success: true, data })
  })

  // :channelId here is really "id or current slug" — joinChannel requires the
  // exact current slug for a private channel (see its own comment).
  app.post('/channels/:channelId/join', { preHandler: [authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    await assertEnabled()
    const { channelId: idOrSlug } = req.params as { channelId: string }
    await joinChannel(req.user!.id, idOrSlug)
    return reply.send({ success: true, data: { joined: true } })
  })

  app.post('/channels/:channelId/leave', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    await leaveChannel(req.user!.id, channelId)
    return reply.send({ success: true, data: { left: true } })
  })

  app.patch('/channels/:channelId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await updateChannel(req.user!.id, channelId, parsed.data)
    return reply.send({ success: true, data })
  })

  app.post('/channels/:channelId/regenerate-invite', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    const data = await regenerateInvite(req.user!.id, channelId)
    return reply.send({ success: true, data })
  })

  app.delete('/channels/:channelId', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    await deleteChannel(req.user!.id, channelId)
    return reply.send({ success: true, data: { deleted: true } })
  })

  app.get('/channels/:channelId/members', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId } = req.params as { channelId: string }
    const data = await listMembers(req.user!.id, channelId)
    return reply.send({ success: true, data })
  })

  app.post('/channels/:channelId/members/:userId/kick', { preHandler: [authenticate] }, async (req, reply) => {
    await assertEnabled()
    const { channelId, userId } = req.params as { channelId: string; userId: string }
    await kickMember(req.user!.id, channelId, userId)
    return reply.send({ success: true, data: { kicked: true } })
  })
}
