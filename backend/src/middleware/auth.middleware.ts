import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyAccessToken } from '../lib/jwt'
import { db } from '../lib/prisma'
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

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return
  const token = authHeader.slice(7)
  const payload = verifyAccessToken(token)
  if (!payload) return
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, role: true, isBanned: true },
  })
  if (user && !user.isBanned) {
    req.user = { id: user.id, email: user.email, role: user.role }
  }
}
