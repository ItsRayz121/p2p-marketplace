import type { FastifyRequest, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'

declare module 'fastify' {
  interface FastifyRequest {
    merchantKey?: {
      id:     string
      userId: string
      name:   string
    }
  }
}

/**
 * Parse API key from Authorization header.
 * Expected format: Bearer mpak_{keyId}_{secret}
 * Returns { keyId, secret } or null if the header is missing / malformed.
 */
function parseApiKey(authHeader: string | undefined): { keyId: string; secret: string } | null {
  if (!authHeader?.startsWith('Bearer mpak_')) return null
  const key = authHeader.slice('Bearer '.length) // mpak_{keyId}_{secret}
  const parts = key.split('_')
  // Format: mpak _ {keyId} _ {secret}  → at least 3 parts
  if (parts.length < 3) return null
  const keyId  = parts[1]
  const secret = parts.slice(2).join('_') // secret may contain underscores
  if (!keyId || !secret) return null
  return { keyId, secret }
}

export async function merchantAuth(req: FastifyRequest, _reply: FastifyReply) {
  const parsed = parseApiKey(req.headers['authorization'] as string | undefined)

  if (!parsed) {
    throw new AppError('UNAUTHORIZED', 'Missing or malformed merchant API key', 401)
  }

  const { keyId, secret } = parsed

  const apiKey = await db.merchantApiKey.findUnique({
    where: { keyId },
    select: { id: true, userId: true, name: true, keyHash: true, isActive: true, rateLimit: true },
  })

  if (!apiKey || !apiKey.isActive) {
    throw new AppError('UNAUTHORIZED', 'Invalid or revoked API key', 401)
  }

  const valid = await bcrypt.compare(secret, apiKey.keyHash)
  if (!valid) {
    throw new AppError('UNAUTHORIZED', 'Invalid or revoked API key', 401)
  }

  // Per-minute rate limit keyed on the DB key id
  const minuteBucket = Math.floor(Date.now() / 60_000)
  const rlKey = `merchant_rl:${apiKey.id}:${minuteBucket}`
  const count = await redis.incr(rlKey)
  if (count === 1) await redis.expire(rlKey, 120)

  if (count > apiKey.rateLimit) {
    throw new AppError('RATE_LIMITED', `API key rate limit: ${apiKey.rateLimit} requests/minute`, 429)
  }

  // Update lastUsedAt at most once per minute (fire-and-forget)
  if (count === 1) {
    db.merchantApiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => logger.warn({ err, keyId: apiKey.id }, 'Failed to update lastUsedAt on merchant key'))
  }

  req.merchantKey = { id: apiKey.id, userId: apiKey.userId, name: apiKey.name }
}
