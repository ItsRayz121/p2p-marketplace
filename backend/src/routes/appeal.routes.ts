import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { authenticateAppeal } from '../middleware/auth.middleware'
import { AppError, Errors } from '../lib/errors'
import { env } from '../lib/env'
import { CLOUDINARY_FOLDERS } from '../lib/cloudinary'
import { db } from '../lib/prisma'
import { computeModerationStatus } from '../lib/moderation'
import '../lib/cloudinary'

// User-facing appeals. Reachable with an appeal-scoped token (issued to
// banned/suspended users at login) OR a normal session token.
export async function appealRoutes(app: FastifyInstance) {
  // GET /appeals/me — current restriction + this user's appeals
  app.get('/appeals/me', { preHandler: [authenticateAppeal] }, async (req, reply) => {
    const userId = req.user!.id
    const [user, appeals] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { isBanned: true, isSuspended: true, bannedUntil: true, suspendedUntil: true, banType: true, underReview: true, moderationReason: true } }),
      db.appeal.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, subjectStatus: true, explanation: true, evidenceUrls: true, decisionNote: true, reviewedAt: true, createdAt: true } }),
    ])
    if (!user) throw Errors.NOT_FOUND('User')
    const status = computeModerationStatus(user)
    return reply.send({
      success: true,
      data: {
        status,
        reason: user.moderationReason ?? null,
        until: (user.isBanned ? user.bannedUntil : user.suspendedUntil)?.toISOString() ?? null,
        canAppeal: user.isBanned || user.isSuspended,
        appeals,
      },
    })
  })

  // POST /appeals — submit an appeal (one active appeal at a time)
  app.post('/appeals', { preHandler: [authenticateAppeal], config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const userId = req.user!.id
    const bodySchema = z.object({
      explanation: z.string().min(20).max(2000),
      evidenceUrls: z.array(z.string().url().max(500)).max(5).optional(),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const user = await db.user.findUnique({ where: { id: userId }, select: { isBanned: true, isSuspended: true, bannedUntil: true, underReview: true } })
    if (!user) throw Errors.NOT_FOUND('User')
    if (!user.isBanned && !user.isSuspended) throw new AppError('NOT_RESTRICTED', 'Your account is not restricted — there is nothing to appeal', 400)

    const existing = await db.appeal.findFirst({ where: { userId, status: { in: ['pending', 'more_info_requested'] } }, select: { id: true } })
    if (existing) throw new AppError('APPEAL_EXISTS', 'You already have an appeal under review', 409)

    const appeal = await db.appeal.create({
      data: {
        userId,
        subjectStatus: computeModerationStatus(user),
        explanation: parsed.data.explanation,
        evidenceUrls: parsed.data.evidenceUrls ?? [],
      },
      select: { id: true, status: true, createdAt: true },
    })
    return reply.send({ success: true, data: appeal })
  })

  // POST /appeals/evidence/presign — Cloudinary upload signature for evidence
  app.post('/appeals/evidence/presign', { preHandler: [authenticateAppeal], config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = z.object({ mimeType: z.string().regex(/^image\/(jpeg|png|webp)$/, 'Only JPEG, PNG or WebP images are allowed') }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    if (!env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_CLOUD_NAME) {
      throw new AppError('CONFIG_ERROR', 'File upload is not configured', 503)
    }
    const folder = CLOUDINARY_FOLDERS.APPEAL_EVIDENCE
    const publicId = randomUUID()
    const timestamp = Math.round(Date.now() / 1000)
    const signature = cloudinary.utils.api_sign_request({ timestamp, public_id: publicId, folder }, env.CLOUDINARY_API_SECRET)
    return reply.send({
      success: true,
      data: {
        url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        fields: { api_key: env.CLOUDINARY_API_KEY, timestamp, public_id: publicId, folder, signature },
        publicUrl: `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${folder}/${publicId}`,
      },
    })
  })
}
