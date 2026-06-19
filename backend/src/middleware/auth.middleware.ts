import type { FastifyRequest, FastifyReply } from 'fastify'
import { verify as otpVerify } from 'otplib'
import { verifyAccessToken, verifyAppealToken } from '../lib/jwt'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'

// Augment FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string; role: string }
  }
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
  }
  const token = authHeader.slice(7)
  const payload = verifyAccessToken(token)
  if (!payload) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired token', 401)
  }
  // Verify user still exists and isn't banned
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true, isBanned: true, isSuspended: true },
  })
  if (!user) throw new AppError('UNAUTHORIZED', 'User not found', 401)
  if (user.isBanned) throw new AppError('ACCOUNT_BANNED', 'Your account has been banned', 403)
  if (user.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Your account has been temporarily suspended', 403)
  req.user = { id: user.id, email: user.email, role: user.role }

  // Track last-seen at most once every 5 minutes per user (fire-and-forget).
  const seenKey = `user-seen:${user.id}`
  redis.set(seenKey, '1', 'EX', 300, 'NX').then((set) => {
    if (set) {
      db.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
    }
  }).catch(() => {})
}

// Accepts EITHER a normal access token OR an appeal-scoped token. Used only by
// the appeal routes so a banned/suspended user (who cannot get a full session)
// can still submit and view their own appeal. Does NOT block banned users.
export async function authenticateAppeal(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
  }
  const token = authHeader.slice(7)
  const appeal = verifyAppealToken(token)
  if (appeal) {
    const user = await db.user.findUnique({ where: { id: appeal.userId }, select: { id: true, email: true, role: true } })
    if (!user) throw new AppError('UNAUTHORIZED', 'User not found', 401)
    req.user = { id: user.id, email: user.email, role: user.role }
    return
  }
  // Fall back to a normal access token (e.g. an under-review user who can log in).
  const payload = verifyAccessToken(token)
  if (!payload) throw new AppError('UNAUTHORIZED', 'Invalid or expired token', 401)
  const user = await db.user.findUnique({ where: { id: payload.userId }, select: { id: true, email: true, role: true } })
  if (!user) throw new AppError('UNAUTHORIZED', 'User not found', 401)
  req.user = { id: user.id, email: user.email, role: user.role }
}

export function requireRole(...roles: string[]) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)
    if (!roles.includes(req.user.role)) {
      throw new AppError('FORBIDDEN', 'Insufficient permissions', 403)
    }
  }
}

// Require a valid TOTP code via X-TOTP-Code header for users who have 2FA enabled.
// If the user has 2FA disabled, this middleware is a no-op (can't enforce what isn't set up).
// Prevents replay attacks by storing used codes in Redis for 90 seconds (±30s TOTP window).
export async function requireTotpIfEnabled(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)

  const record = await db.user.findUnique({
    where: { id: req.user.id },
    select: { twoFaEnabled: true, twoFaSecret: true },
  })
  if (!record?.twoFaEnabled || !record.twoFaSecret) return

  const code = (req.headers['x-totp-code'] as string | undefined)?.trim()
  if (!code) {
    throw new AppError('TOTP_REQUIRED', '2FA code required for this action — provide it in X-TOTP-Code header', 403)
  }

  await verifyTotpCode(req.user.id, code, record.twoFaSecret)
}

// Shared TOTP verification with replay guard. Throws on invalid/replayed codes.
async function verifyTotpCode(userId: string, code: string, secret: string): Promise<void> {
  // Replay guard — each 6-digit code is valid for one use within its 90-second window
  const replayKey = `totp:used:${userId}:${code}`
  const alreadyUsed = await redis.get(replayKey)
  if (alreadyUsed) {
    throw new AppError('TOTP_REPLAY', '2FA code has already been used — wait for the next code', 403)
  }

  const result = await otpVerify({ token: code, secret })
  const valid = (result as { valid: boolean }).valid
  if (!valid) {
    throw new AppError('TOTP_INVALID', 'Invalid 2FA code', 403)
  }

  // Mark code as used; TTL covers the full TOTP window (30s step × 3 = 90s)
  await redis.set(replayKey, '1', 'EX', 90)
}

// "Sudo mode" grace window: how long a single successful step-up is honoured for
// subsequent admin actions before a fresh 2FA code is required again.
const STEP_UP_GRACE_SECONDS = 5 * 60

// Step-up variant for admin actions. Behaves like requireTotpIfEnabled, but a
// successful verification opens a short grace window so admins don't have to
// re-enter their authenticator code on every single config click. Wallet
// withdrawals deliberately keep using the strict requireTotpIfEnabled.
export async function requireAdminStepUp(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)

  const record = await db.user.findUnique({
    where: { id: req.user.id },
    select: { twoFaEnabled: true, twoFaSecret: true },
  })
  if (!record?.twoFaEnabled || !record.twoFaSecret) return

  const graceKey = `totp:stepup:${req.user.id}`
  const code = (req.headers['x-totp-code'] as string | undefined)?.trim()

  if (!code) {
    // Within an active grace window? Allow without re-prompting for a fresh code.
    const grace = await redis.get(graceKey)
    if (grace) return
    throw new AppError('TOTP_REQUIRED', '2FA code required for this action — provide it in X-TOTP-Code header', 403)
  }

  await verifyTotpCode(req.user.id, code, record.twoFaSecret)
  // Open/refresh the grace window so the next few minutes of admin actions are smooth.
  await redis.set(graceKey, '1', 'EX', STEP_UP_GRACE_SECONDS)
}

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return
  const token = authHeader.slice(7)
  const payload = verifyAccessToken(token)
  if (!payload) return
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true, isBanned: true, isSuspended: true },
  })
  if (user && !user.isBanned && !user.isSuspended) {
    req.user = { id: user.id, email: user.email, role: user.role }
  }
}
