import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { AppError } from '../lib/errors'
import { generateCsrfToken } from '../lib/csrf'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { hashPassword, verifyPassword, hashToken } from '../lib/hash'
import { applyWithdrawalLock } from '../services/withdrawal-security.service'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import {
  register,
  login,
  verifyEmailAndLogin,
  resendOtp,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  logout,
  getMe,
  setup2Fa,
  enable2Fa,
  disable2Fa,
  verify2Fa,
  loginOrRegisterWithGoogle,
  COOKIE_OPTIONS,
} from '../services/auth.service'
import {
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_OPTIONS,
  listTrustedDevices,
  revokeTrustedDevice,
  revokeAllTrustedDevices,
} from '../services/trusted-device.service'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { assertTurnstileValid } from '../lib/turnstile'

// ─── Validation Schemas ───────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long'),
  fullName: z.string().min(2, 'Full name too short').max(100, 'Full name too long'),
  referralCode: z.string().optional(),
  intendedRole: z.enum(['user', 'merchant']).optional(),
  // Cloudflare Turnstile token — required only when TURNSTILE_SECRET_KEY is set
  turnstileToken: z.string().optional(),
})

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  turnstileToken: z.string().optional(),
})

const verifyEmailSchema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().length(6, 'OTP must be 6 digits'),
})

const resendOtpSchema = z.object({
  email: z.string().email('Invalid email address'),
  type: z.enum(['verify', 'reset']),
})

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
})

const resetPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().length(6, 'OTP must be 6 digits'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long'),
})

const twoFaCodeSchema = z.object({
  code: z.string().min(6).max(6, '2FA code must be 6 digits'),
})

const verify2FaSchema = z.object({
  preAuthToken: z.string().min(1, 'Pre-auth token is required'),
  code: z.string().length(6, '2FA code must be 6 digits'),
  // Opt-in "Trust this device for 30 days" — skips the login code next time.
  trustDevice: z.boolean().optional(),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function authRoutes(app: FastifyInstance) {
  // GET /csrf — fetch a CSRF token. Tokens are intentionally NOT bound to a
  // user: the csrfHook runs at onRequest (before authenticate populates
  // req.user), so it always validates in guest scope. User-bound tokens were
  // silently failing validation and only worked because the frontend retried
  // with an unauthenticated fetch. The real CSRF protection is the custom
  // X-CSRF-Token header + CORS origin restriction, which binding adds nothing to.
  app.get('/csrf', async (_req, reply) => {
    return reply.send({ success: true, data: { token: generateCsrfToken() } })
  })

  // POST /register
  app.post(
    '/register',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const body = registerSchema.parse(req.body)
      await assertTurnstileValid(body.turnstileToken, req.ip)
      const { referralCode, intendedRole, turnstileToken: _t, ...coreFields } = body
      const result = await register({
        ...coreFields,
        ...(referralCode ? { referralCode } : {}),
        ...(intendedRole ? { intendedRole } : {}),
        ip: req.ip,
      })
      return reply.status(201).send({ success: true, data: result })
    },
  )

  // POST /login
  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '15 minutes' },
      },
    },
    async (req, reply) => {
      const body = loginSchema.parse(req.body)
      await assertTurnstileValid(body.turnstileToken, req.ip)
      const { turnstileToken: _t, ...credentials } = body
      const ua = req.headers['user-agent']
      const deviceTrustToken = req.cookies?.[DEVICE_COOKIE_NAME]
      const result = await login({
        ...credentials,
        ...(ua ? { userAgent: ua } : {}),
        ip: req.ip,
        ...(deviceTrustToken ? { deviceTrustToken } : {}),
      })

      if (result.refreshToken) {
        reply.setCookie('refresh_token', result.refreshToken, COOKIE_OPTIONS)
      }

      return reply.send({
        success: true,
        data: {
          requiresTwoFa: result.requiresTwoFa,
          accessToken: result.accessToken,
          preAuthToken: result.preAuthToken,
          user: result.user,
          restricted: result.restricted,
        },
      })
    },
  )

  // POST /verify-email — verifies OTP and auto-creates a session so the
  // frontend can proceed without a separate login step.
  app.post('/verify-email', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { email, code } = verifyEmailSchema.parse(req.body)
    const user = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
    const ua = req.headers['user-agent']
    const result = await verifyEmailAndLogin(user.id, code, ua ?? undefined, req.ip)
    reply.setCookie('refresh_token', result.refreshToken, COOKIE_OPTIONS)
    return reply.send({
      success: true,
      data: {
        message: 'Email verified successfully.',
        accessToken: result.accessToken,
        user: result.user,
      },
    })
  })

  // POST /resend-otp
  app.post(
    '/resend-otp',
    {
      config: {
        rateLimit: { max: 3, timeWindow: '15 minutes' },
      },
    },
    async (req, reply) => {
      const { email, type } = resendOtpSchema.parse(req.body)
      await resendOtp(email, type)
      return reply.send({
        success: true,
        data: { message: 'If the email exists, a new code has been sent.' },
      })
    },
  )

  // POST /forgot-password
  app.post(
    '/forgot-password',
    {
      config: {
        rateLimit: { max: 3, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const { email } = forgotPasswordSchema.parse(req.body)
      await forgotPassword(email)
      return reply.send({
        success: true,
        data: { message: 'If the email exists, a reset code has been sent.' },
      })
    },
  )

  // POST /reset-password
  app.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = resetPasswordSchema.parse(req.body)
    await resetPassword(body.email, body.code, body.newPassword)
    return reply.send({ success: true, data: { message: 'Password reset successfully.' } })
  })

  // POST /refresh — exchange refresh token cookie for new access token
  app.post('/refresh', async (req, reply) => {
    const refreshToken = req.cookies?.['refresh_token']
    if (!refreshToken) {
      throw new AppError('UNAUTHORIZED', 'No refresh token provided', 401)
    }
    const result = await refreshAccessToken(refreshToken)
    return reply.send({ success: true, data: result })
  })

  // POST /logout
  app.post('/logout', { preHandler: [authenticate] }, async (req, reply) => {
    const refreshToken = req.cookies?.['refresh_token']
    await logout(req.user!.id, refreshToken)
    reply.clearCookie('refresh_token', {
      path: '/',
      sameSite: COOKIE_OPTIONS.sameSite,
      secure: COOKIE_OPTIONS.secure,
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    })
    return reply.send({ success: true, data: { message: 'Logged out successfully.' } })
  })

  // GET /me
  app.get('/me', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await getMe(req.user!.id)
    return reply.send({ success: true, data: { user } })
  })

  // POST /2fa/setup — generate secret + QR code
  app.post('/2fa/setup', { preHandler: [authenticate] }, async (req, reply) => {
    const result = await setup2Fa(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // POST /2fa/enable — confirm secret with a code to activate 2FA
  app.post('/2fa/enable', { preHandler: [authenticate] }, async (req, reply) => {
    const { code } = twoFaCodeSchema.parse(req.body)
    await enable2Fa(req.user!.id, code)
    return reply.send({ success: true, data: { message: '2FA enabled successfully.' } })
  })

  // POST /2fa/disable
  app.post('/2fa/disable', { preHandler: [authenticate] }, async (req, reply) => {
    const { code } = twoFaCodeSchema.parse(req.body)
    await disable2Fa(req.user!.id, code)
    return reply.send({ success: true, data: { message: '2FA disabled successfully.' } })
  })

  // POST /2fa/verify — complete login with pre-auth token + TOTP code
  app.post(
    '/2fa/verify',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (req, reply) => {
      const { preAuthToken, code, trustDevice } = verify2FaSchema.parse(req.body)
      const result = await verify2Fa(preAuthToken, code, req.headers['user-agent'], req.ip, trustDevice ?? false)

      if (result.refreshToken) {
        reply.setCookie('refresh_token', result.refreshToken, COOKIE_OPTIONS)
      }
      if (result.deviceTrustToken) {
        reply.setCookie(DEVICE_COOKIE_NAME, result.deviceTrustToken, DEVICE_COOKIE_OPTIONS)
      }

      return reply.send({
        success: true,
        data: {
          accessToken: result.accessToken,
          user: result.user,
        },
      })
    },
  )

  // GET /check-username?username=...
  app.get('/check-username', async (req, reply) => {
    const username = (req.query as { username?: string }).username?.trim()
    if (!username || username.length < 3 || username.length > 30) {
      return reply.send({ success: true, data: { available: false } })
    }
    const existing = await db.user.findUnique({ where: { username }, select: { id: true } })
    return reply.send({ success: true, data: { available: !existing } })
  })

  // PATCH /profile — update fullName/username
  const profileSchema = z.object({
    fullName: z.string().min(2).max(100).optional(),
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain only letters, numbers, and underscores')
      .optional(),
  })
  app.patch('/profile', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = profileSchema.parse(req.body)

    const current = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { username: true, usernameChangedAt: true, legalNameLockedAt: true },
    })
    if (!current) throw new AppError('NOT_FOUND', 'User not found', 404)

    // Once the name is locked to the verified CNIC legal name, the user can no
    // longer self-edit it (admin override only). Username stays freely editable.
    if (parsed.fullName && current.legalNameLockedAt && (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P))) {
      throw new AppError(
        'NAME_LOCKED',
        'Your name is verified from your CNIC and cannot be changed. Contact support if it is incorrect.',
        403,
      )
    }

    const isUsernameChange = parsed.username && parsed.username !== current.username
    if (isUsernameChange) {
      if (current.usernameChangedAt) {
        const cooldownMs = 30 * 24 * 60 * 60 * 1000
        const nextAllowed = new Date(current.usernameChangedAt.getTime() + cooldownMs)
        if (new Date() < nextAllowed) {
          throw new AppError(
            'TOO_MANY_REQUESTS',
            `Username can be changed again on ${nextAllowed.toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'long', year: 'numeric' })}`,
            429,
          )
        }
      }
      const taken = await db.user.findFirst({
        where: { username: parsed.username!, NOT: { id: req.user!.id } },
        select: { id: true },
      })
      if (taken) throw new AppError('CONFLICT', 'Username is already taken', 409)
    }

    const data: Record<string, unknown> = {}
    if (parsed.fullName) data.fullName = parsed.fullName
    if (isUsernameChange) {
      data.username = parsed.username
      data.usernameChangedAt = new Date()
    }
    if (Object.keys(data).length > 0) {
      await db.user.update({ where: { id: req.user!.id }, data })
    }
    const user = await getMe(req.user!.id)
    return reply.send({ success: true, data: user })
  })

  // POST /change-password
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  })
  app.post('/change-password', { preHandler: [authenticate] }, async (req, reply) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body)
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { passwordHash: true },
    })
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
    const ok = await verifyPassword(currentPassword, user.passwordHash)
    if (!ok) throw new AppError('UNAUTHORIZED', 'Current password is incorrect', 401)
    const newHash = await hashPassword(newPassword)
    await db.user.update({ where: { id: req.user!.id }, data: { passwordHash: newHash } })
    // Revoke all refresh sessions so other devices are signed out.
    await db.session.updateMany({
      where: { userId: req.user!.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    // Lock withdrawals for 24h after a password change (security policy).
    void applyWithdrawalLock(req.user!.id, 'password_changed').catch(() => {})
    // Security event — clear trusted devices so 2FA is required again everywhere.
    void revokeAllTrustedDevices(req.user!.id).catch(() => {})
    return reply.send({ success: true, data: { message: 'Password changed successfully.' } })
  })

  // GET /sessions — list active refresh sessions
  app.get('/sessions', { preHandler: [authenticate] }, async (req, reply) => {
    const currentToken = req.cookies?.['refresh_token']
    const sessions = await db.session.findMany({
      where: { userId: req.user!.id, type: 'refresh', revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true, token: true },
    })
    return reply.send({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent ?? '',
        ip: s.ip ?? '',
        createdAt: s.createdAt,
        lastActiveAt: s.createdAt,
        // Compare stored hash to hash of the current cookie — never expose the hash itself.
        isCurrent: currentToken ? s.token === hashToken(currentToken) : false,
      })),
    })
  })

  // DELETE /sessions/:id — revoke a session
  app.delete('/sessions/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = await db.session.findUnique({ where: { id }, select: { userId: true } })
    if (!session) throw new AppError('NOT_FOUND', 'Session not found', 404)
    if (session.userId !== req.user!.id) throw new AppError('FORBIDDEN', 'Forbidden', 403)
    await db.session.update({ where: { id }, data: { revokedAt: new Date() } })
    return reply.send({ success: true, data: { message: 'Session revoked.' } })
  })

  // GET /devices — list trusted devices (those that skip the login 2FA code)
  app.get('/devices', { preHandler: [authenticate] }, async (req, reply) => {
    const currentToken = req.cookies?.[DEVICE_COOKIE_NAME]
    const devices = await listTrustedDevices(req.user!.id, currentToken)
    return reply.send({ success: true, data: devices })
  })

  // DELETE /devices/:id — forget (un-trust) a single device
  app.delete('/devices/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await revokeTrustedDevice(req.user!.id, id)
    return reply.send({ success: true, data: { message: 'Device forgotten.' } })
  })

  // DELETE /devices — forget ALL trusted devices (the "log out everywhere" backstop)
  app.delete('/devices', { preHandler: [authenticate] }, async (req, reply) => {
    await revokeAllTrustedDevices(req.user!.id)
    // Also clear the cookie on the current browser so it re-enrols next time.
    reply.clearCookie(DEVICE_COOKIE_NAME, {
      path: '/',
      sameSite: DEVICE_COOKIE_OPTIONS.sameSite,
      secure: DEVICE_COOKIE_OPTIONS.secure,
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    })
    return reply.send({ success: true, data: { message: 'All trusted devices forgotten.' } })
  })

  // Local error handler for this plugin scope.
  // Fastify does NOT re-process errors thrown from inside a setErrorHandler,
  // so we must reply directly for every shape we care about — re-throwing
  // turns AppError(401) into a generic 500.
  app.setErrorHandler((err, req, reply) => {
    // AppError FIRST — it has a statusCode property that would otherwise be caught
    // by the generic httpStatus >= 400 fallback, losing the specific error.code.
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        success: false,
        error: err.code,
        message: err.message,
      })
    }

    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      })
    }

    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
      })
    }

    // @fastify/rate-limit and FastifyError (body parsing) carry statusCode but are not
    // AppError instances — handle them here after all instanceof checks.
    const httpStatus = (err as { statusCode?: number }).statusCode
    if (httpStatus === 429) {
      return reply.status(429).send({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: (err as { message?: string }).message ?? 'Too many requests. Please wait before retrying.',
      })
    }
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return reply.status(httpStatus).send({
        success: false,
        error: 'REQUEST_ERROR',
        message: (err as { message?: string }).message ?? 'Invalid request',
      })
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        return reply.status(404).send({ success: false, error: 'NOT_FOUND', message: 'Record not found' })
      }
      if (err.code === 'P2002') {
        return reply.status(409).send({ success: false, error: 'CONFLICT', message: 'A record with this data already exists' })
      }
      req.log.error({ err, prismaCode: err.code }, 'Prisma error in auth')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }
    if (
      err instanceof Prisma.PrismaClientInitializationError ||
      err instanceof Prisma.PrismaClientRustPanicError
    ) {
      req.log.error({ err }, 'Database connection error in auth')
      return reply.status(503).send({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable' })
    }
    if (err instanceof Prisma.PrismaClientValidationError) {
      req.log.error({ err, message: err.message }, 'Prisma validation error in auth — likely schema/query mismatch')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }
    if (err instanceof Prisma.PrismaClientUnknownRequestError) {
      req.log.error({ err, message: err.message }, 'Prisma unknown request error in auth')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }
    req.log.error({ err, message: (err as Error).message, stack: (err as Error).stack }, 'Unhandled auth error')
    return reply.status(500).send({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    })
  })

  // ─── Google OAuth ──────────────────────────────────────────────────────────

  // Step 1: redirect user to Google consent screen
  app.get('/google', async (_req, reply) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CALLBACK_URL) {
      // Redirect to a friendly login error instead of dead-ending on raw JSON.
      return reply.redirect(`${env.FRONTEND_URL}/login?error=google_not_configured`)
    }
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
    })
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
  })

  // Step 2: Google redirects back here with a code
  app.get('/google/callback', async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string }
    const frontendUrl = env.FRONTEND_URL

    if (error || !code) {
      return reply.redirect(`${frontendUrl}/login?error=google_cancelled`)
    }

    try {
      // Exchange authorization code for access token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: env.GOOGLE_CALLBACK_URL!,
          grant_type: 'authorization_code',
        }).toString(),
      })

      const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
      if (!tokenData.access_token) {
        logger.warn({ tokenData }, 'Google token exchange failed')
        return reply.redirect(`${frontendUrl}/login?error=google_failed`)
      }

      // Fetch user profile from Google
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      })
      const googleUser = await userRes.json() as { id?: string; email?: string; name?: string }

      if (!googleUser.id || !googleUser.email) {
        return reply.redirect(`${frontendUrl}/login?error=google_failed`)
      }

      const result = await loginOrRegisterWithGoogle(
        googleUser.id,
        googleUser.email,
        googleUser.name ?? (googleUser.email.split('@')[0] ?? 'user'),
        req.headers['user-agent'],
        req.ip,
      )

      // Banned / suspended Google users → restricted appeal flow.
      if (result.restricted) {
        return reply.redirect(`${frontendUrl}/account/restricted?token=${encodeURIComponent(result.restricted.appealToken)}&status=${result.restricted.status}`)
      }

      if (result.refreshToken) reply.setCookie('refresh_token', result.refreshToken, COOKIE_OPTIONS)
      return reply.redirect(`${frontendUrl}/auth/google/success?token=${encodeURIComponent(result.accessToken ?? '')}`)
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback error')
      const msg = err instanceof Error && err.message.includes('suspended') ? 'account_suspended' : 'google_failed'
      return reply.redirect(`${frontendUrl}/login?error=${msg}`)
    }
  })
}
