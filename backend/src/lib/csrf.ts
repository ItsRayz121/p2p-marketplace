import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { env } from './env'

const CSRF_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Routes that are exempt from CSRF (webhooks use HMAC, health check is safe)
const CSRF_EXEMPT = new Set([
  '/health',
  '/health/ping',
  '/api/v1/webhooks/moralis',
  '/api/v1/webhooks/tatum',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/verify-email',
  '/api/auth/resend-otp',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/refresh',
  '/api/auth/2fa/verify',
  '/api/gas-fee/orders',
  '/api/gas-fee/prices',
  '/api/webhooks/deposit',
])

function sign(payload: string): string {
  return createHmac('sha256', env.CSRF_SECRET).update(payload).digest('hex')
}

export function generateCsrfToken(): string {
  const nonce = randomBytes(16).toString('hex')
  const expires = Date.now() + CSRF_TOKEN_TTL_MS
  const payload = `${nonce}:${expires}`
  const sig = sign(payload)
  return `${payload}:${sig}`
}

export function validateCsrfToken(token: string): boolean {
  const parts = token.split(':')
  if (parts.length !== 3) return false
  const [nonce, expiresStr, sig] = parts
  const expires = parseInt(expiresStr ?? '0', 10)
  if (isNaN(expires) || Date.now() > expires) return false
  const payload = `${nonce}:${expires}`
  const expected = sign(payload)
  try {
    return timingSafeEqual(Buffer.from(sig ?? ''), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function csrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!UNSAFE_METHODS.has(req.method)) return
  if (CSRF_EXEMPT.has(req.url)) return

  const token = req.headers['x-csrf-token']
  if (typeof token !== 'string' || !validateCsrfToken(token)) {
    return reply.status(403).send({
      success: false,
      error: 'INVALID_CSRF_TOKEN',
      message: 'Missing or invalid CSRF token. Fetch a new token from GET /api/v1/auth/csrf.',
    })
  }
}
