import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  startEmailLink,
  verifyEmailLink,
  createTelegramLinkToken,
} from '../services/accountLink.service'

const emailStartSchema = z.object({
  email: z.string().email('Enter a valid email address').max(254),
})

const emailVerifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().length(6),
  // Optional — lets a Telegram-only user set a website password while adding
  // their email, so email/password login becomes usable in one step.
  password: z.string().min(8).max(128).optional(),
})

// Account linking — connect a real email and/or a Telegram identity to the
// signed-in account. All routes require auth; the user links onto THEIR OWN
// account only.
export async function accountLinkRoutes(app: FastifyInstance) {
  // POST /api/v1/account/email/start — send an OTP to the new email
  app.post(
    '/account/email/start',
    { preHandler: [authenticate], config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const parsed = emailStartSchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
      }
      await startEmailLink(req.user!.id, parsed.data.email)
      return reply.send({ success: true, data: { message: 'Verification code sent' } })
    },
  )

  // POST /api/v1/account/email/verify — confirm OTP, set the email (+ password)
  app.post(
    '/account/email/verify',
    { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const parsed = emailVerifySchema.safeParse(req.body)
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
      }
      const { email, code, password } = parsed.data
      const user = await verifyEmailLink(req.user!.id, email, code, password)
      return reply.send({ success: true, data: user })
    },
  )

  // POST /api/v1/account/telegram/link-token — mint a bot deep-link token
  app.post(
    '/account/telegram/link-token',
    { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const result = await createTelegramLinkToken(req.user!.id)
      return reply.send({
        success: true,
        data: { deepLink: result.deepLink, expiresAt: result.expiresAt.toISOString() },
      })
    },
  )
}
