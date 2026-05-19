import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { getKycStatus, submitKyc, getUserSubmissions } from '../services/kyc.service'
import { AppError } from '../lib/errors'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const submitKycSchema = z.object({
  tier: z.enum(['basic', 'enhanced']),
  cnicNumber: z.string().regex(/^\d{5}-\d{7}-\d$|^\d{13}$/, 'Invalid CNIC format (expected XXXXX-XXXXXXX-X or 13 digits)'),
  frontUrl: z.string().url(),
  backUrl: z.string().url(),
  selfieUrl: z.string().url(),
  socialLinks: z
    .array(
      z.object({
        platform: z.string().min(1),
        url: z.string().url(),
      }),
    )
    .optional(),
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
    const { socialLinks, ...kycCore } = parsed.data
    const submission = await submitKyc(userId, {
      ...kycCore,
      ...(socialLinks ? { socialLinks } : {}),
    })
    return reply.code(201).send({ success: true, data: submission })
  })

  // GET /api/kyc/submissions
  app.get('/kyc/submissions', { preHandler: [authenticate] }, async (req, reply) => {
    const submissions = await getUserSubmissions(req.user!.id)
    return reply.send({ success: true, data: submissions })
  })
}
