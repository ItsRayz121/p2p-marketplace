import type { FastifyRequest, FastifyReply } from 'fastify'
import { verify as otpVerify } from 'otplib'
import { verifyAccessToken } from '../lib/jwt'
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

  // Replay guard — each 6-digit code is valid for one use within its 90-second window
  const replayKey = `totp:used:${req.user.id}:${code}`
  const alreadyUsed = await redis.get(replayKey)
  if (alreadyUsed) {
    throw new AppError('TOTP_REPLAY', '2FA code has already been used — wait for the next code', 403)
  }

  const result = await otpVerify({ token: code, secret: record.twoFaSecret })
  const valid = (result as { valid: boolean }).valid
  if (!valid) {
    throw new AppError('TOTP_INVALID', 'Invalid 2FA code', 403)
  }

  // Mark code as used; TTL covers the full TOTP window (30s step × 3 = 90s)
  await redis.set(replayKey, '1', 'EX', 90)
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
