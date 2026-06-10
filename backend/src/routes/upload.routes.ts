import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { v2 as cloudinary } from 'cloudinary'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { assertCloudinaryUrl } from '../lib/upload'
import { env } from '../lib/env'
import { CLOUDINARY_FOLDERS } from '../lib/cloudinary'
import { db } from '../lib/prisma'
import { getMe } from '../services/auth.service'

// Import cloudinary so it's already configured (cloudinary.ts does the config)
import '../lib/cloudinary'

const presignSchema = z
  .object({
    type: z.enum(['kyc-front', 'kyc-back', 'kyc-selfie', 'payment-proof', 'merchant-proof', 'avatar', 'kyc-video']),
    mimeType: z.string(),
  })
  .refine(
    (d) =>
      d.type === 'kyc-video'
        ? /^video\/(mp4|quicktime|webm)$/.test(d.mimeType)
        : /^image\/(jpeg|png|webp)$/.test(d.mimeType),
    { message: 'Unsupported file type for this upload' },
  )

const folderMap: Record<string, string> = {
  'kyc-front': CLOUDINARY_FOLDERS.KYC_FRONT,
  'kyc-back': CLOUDINARY_FOLDERS.KYC_BACK,
  'kyc-selfie': CLOUDINARY_FOLDERS.KYC_SELFIE,
  'kyc-video': CLOUDINARY_FOLDERS.KYC_VIDEO,
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
    const resourceType = type === 'kyc-video' ? 'video' : 'image'
    const publicId = randomUUID()
    const timestamp = Math.round(Date.now() / 1000)

    // KYC documents (CNIC, selfie, video) are uploaded as `authenticated`
    // assets: the bare delivery URL 404s without a server-generated signature
    // (see signCloudinaryDeliveryUrl). Everything else stays public `upload`.
    const isKycDoc = type.startsWith('kyc-')
    const deliveryType = isKycDoc ? 'authenticated' : 'upload'

    const paramsToSign = isKycDoc
      ? { timestamp, public_id: publicId, folder, type: deliveryType }
      : { timestamp, public_id: publicId, folder }
    const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET)

    return reply.send({
      success: true,
      data: {
        url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
        fields: {
          api_key: env.CLOUDINARY_API_KEY,
          timestamp,
          public_id: publicId,
          folder,
          signature,
          ...(isKycDoc ? { type: deliveryType } : {}),
        },
        publicUrl: `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/${deliveryType}/${folder}/${publicId}`,
      },
    })
  })

  // PATCH /api/upload/avatar — save confirmed avatar URL to user profile
  const avatarSchema = z.object({ avatarUrl: z.string().url().max(500) })
  app.patch('/upload/avatar', { preHandler: [authenticate] }, async (req, reply) => {
    const { avatarUrl } = avatarSchema.parse(req.body)
    // Only our own Cloudinary uploads — same rule as payment proofs. Prevents
    // storing arbitrary third-party image URLs (tracking pixels, phishing).
    assertCloudinaryUrl(avatarUrl, 'avatarUrl')
    await db.user.update({ where: { id: req.user!.id }, data: { avatarUrl } })
    const user = await getMe(req.user!.id)
    return reply.send({ success: true, data: user })
  })
}
