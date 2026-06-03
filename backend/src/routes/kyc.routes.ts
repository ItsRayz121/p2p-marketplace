import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { getKycStatus, submitKyc, getUserSubmissions } from '../services/kyc.service'
import { AppError } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const submitKycSchema = z.object({
  tier: z.enum(['basic', 'enhanced']),
  // CNIC details + document photos are only collected for Basic (Level 1). For
  // Enhanced (Level 2) these are reused from the user's approved Level 1
  // submission — see submitKyc — so they are optional here.
  cnicNumber: z.string().regex(/^\d{5}-\d{7}-\d$|^\d{13}$/, 'Invalid CNIC format (expected XXXXX-XXXXXXX-X or 13 digits)').optional(),
  frontUrl: z.string().url().optional(),
  backUrl: z.string().url().optional(),
  selfieUrl: z.string().url().optional(),
  videoUrl: z.string().url().optional(),
  socialLinks: z
    .array(
      z.object({
        platform: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .optional(),
})
  // Basic KYC still requires CNIC number + front/back/selfie photos.
  .refine((d) => d.tier !== 'basic' || (!!d.cnicNumber && !!d.frontUrl && !!d.backUrl && !!d.selfieUrl), {
    message: 'Basic KYC requires your CNIC number and front, back, and selfie photos',
    path: ['frontUrl'],
  })
  .refine((d) => d.tier !== 'enhanced' || (d.socialLinks?.filter((l) => l.url.trim()).length ?? 0) >= 2, {
    message: 'Enhanced KYC requires at least 2 social media profiles',
    path: ['socialLinks'],
  })
  .refine((d) => d.tier !== 'enhanced' || !!d.videoUrl, {
    message: 'Enhanced KYC requires a short verification video',
    path: ['videoUrl'],
  })

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function kycRoutes(app: FastifyInstance) {
  // GET /api/kyc/status
  app.get('/kyc/status', { preHandler: [authenticate] }, async (req, reply) => {
    const result = await getKycStatus(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // POST /api/kyc/submit
  app.post('/kyc/submit', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = submitKycSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tier, cnicNumber, frontUrl, backUrl, selfieUrl, videoUrl, socialLinks } = parsed.data
    // Build the payload with only defined fields (exactOptionalPropertyTypes).
    const submission = await submitKyc(userId, {
      tier,
      ...(cnicNumber ? { cnicNumber } : {}),
      ...(frontUrl ? { frontUrl } : {}),
      ...(backUrl ? { backUrl } : {}),
      ...(selfieUrl ? { selfieUrl } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(socialLinks ? { socialLinks } : {}),
    })
    void createAdminNotif({
      category: 'KYC',
      title:    'New KYC Submission',
      body:     `User submitted ${tier} KYC. Submission ID: ${submission.id}`,
      href:     `/admin/kyc`,
      metadata: { userId, submissionId: submission.id, tier },
    })
    return reply.code(201).send({ success: true, data: submission })
  })

  // GET /api/kyc/submissions
  app.get('/kyc/submissions', { preHandler: [authenticate] }, async (req, reply) => {
    const submissions = await getUserSubmissions(req.user!.id)
    return reply.send({ success: true, data: submissions })
  })
}
