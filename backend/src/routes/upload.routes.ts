import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { CLOUDINARY_FOLDERS } from '../lib/cloudinary'
import { db } from '../lib/prisma'
import { getMe } from '../services/auth.service'

// Import cloudinary so it's already configured (cloudinary.ts does the config)
import '../lib/cloudinary'

const presignSchema = z.object({
  type: z.enum(['kyc-front', 'kyc-back', 'kyc-selfie', 'payment-proof', 'merchant-proof', 'avatar']),
  mimeType: z.string().regex(/^image\/(jpeg|png|webp)$/, 'Only JPEG, PNG, and WebP are allowed'),
})

const folderMap: Record<string, string> = {
  'kyc-front': CLOUDINARY_FOLDERS.KYC_FRONT,
  'kyc-back': CLOUDINARY_FOLDERS.KYC_BACK,
  'kyc-selfie': CLOUDINARY_FOLDERS.KYC_SELFIE,
  'payment-proof': CLOUDINARY_FOLDERS.PAYMENT_PROOF,
  'merchant-proof': CLOUDINARY_FOLDERS.MERCHANT_PROOF,
  'avatar': CLOUDINARY_FOLDERS.AVATAR,
}

export async function uploadRoutes(app: FastifyInstance) {
  // POST /api/upload/presign
  app.post('/upload/presign', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = presignSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    if (!env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_CLOUD_NAME) {
      throw new AppError('CONFIG_ERROR', 'File upload is not configured', 503)
    }

    const { type } = parsed.data
    const folder = folderMap[type]!
    const publicId = randomUUID()
    const timestamp = Math.round(Date.now() / 1000)

    const paramsToSign = { timestamp, public_id: publicId, folder }
    const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET)

    return reply.send({
      success: true,
      data: {
        url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        fields: {
          api_key: env.CLOUDINARY_API_KEY,
          timestamp,
          public_id: publicId,
          folder,
          signature,
        },
        publicUrl: `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${folder}/${publicId}`,
      },
    })
  })

  // PATCH /api/upload/avatar — save confirmed avatar URL to user profile
  const avatarSchema = z.object({ avatarUrl: z.string().url().max(500) })
  app.patch('/upload/avatar', { preHandler: [authenticate] }, async (req, reply) => {
    const { avatarUrl } = avatarSchema.parse(req.body)
    await db.user.update({ where: { id: req.user!.id }, data: { avatarUrl } })
    const user = await getMe(req.user!.id)
    return reply.send({ success: true, data: user })
  })
}
