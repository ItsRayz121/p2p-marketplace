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
  '/api/v1/webhooks/deposit',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-otp',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/refresh',
  '/api/v1/auth/2fa/verify',
  // Telegram Mini App: auth-bootstrap (analogous to /auth/login) + bot webhook
  // (authenticated via the X-Telegram-Bot-Api-Secret-Token header, not CSRF).
  '/api/v1/miniapp/auth',
  '/api/v1/telegram/webhook',
  // Gas fee order creation uses optionalAuth — guests can create orders (no funds move at creation time).
  // Authenticated users can call these too; their browsers should send a CSRF token if available.
  '/api/v1/gas-fee/orders',
  '/api/v1/gas-fee/orders/crypto',
  '/api/v1/gas-fee/prices',
  '/api/v1/gas-fee/custom-request',
])

function sign(payload: string): string {
  return createHmac('sha256', env.CSRF_SECRET).update(payload).digest('hex')
}

// Generate a CSRF token optionally bound to a userId.
// When userId is provided the token is tied to that user — another user's
// valid token will not pass validation for a different userId.
export function generateCsrfToken(userId?: string): string {
  const nonce = randomBytes(16).toString('hex')
  const expires = Date.now() + CSRF_TOKEN_TTL_MS
  const uid = userId ?? 'guest'
  const payload = `${nonce}:${expires}:${uid}`
  const sig = sign(payload)
  return `${payload}:${sig}`
}

export function validateCsrfToken(token: string, userId?: string): boolean {
  const parts = token.split(':')
  if (parts.length !== 4) return false
  const [nonce, expiresStr, uid, sig] = parts
  const expires = parseInt(expiresStr ?? '0', 10)
  if (isNaN(expires) || Date.now() > expires) return false
  // If a userId is provided, it must match the one embedded in the token.
  const expectedUid = userId ?? 'guest'
  if (uid !== expectedUid) return false
  const payload = `${nonce}:${expires}:${uid}`
  const expected = sign(payload)
  try {
    return timingSafeEqual(Buffer.from(sig ?? ''), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function csrfHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!UNSAFE_METHODS.has(req.method)) return
  // Match on the pathname only — req.url includes the querystring, so a request
  // like `/api/v1/auth/login?x=1` would otherwise miss the exempt set.
  const pathname = req.url.split('?')[0] ?? req.url
  if (CSRF_EXEMPT.has(pathname)) return

  const token = req.headers['x-csrf-token']
  // req.user is populated by authenticate preHandler on protected routes;
  // on public (non-exempt) routes it will be undefined → guest validation.
  const userId = req.user?.id
  if (typeof token !== 'string' || !validateCsrfToken(token, userId)) {
    return reply.status(403).send({
      success: false,
      error: 'INVALID_CSRF_TOKEN',
      message: 'Missing or invalid CSRF token. Fetch a new token from GET /api/v1/auth/csrf.',
    })
  }
}
