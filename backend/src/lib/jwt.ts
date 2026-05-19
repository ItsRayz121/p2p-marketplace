// Custom HS256 JWT implementation. Functionally correct (timing-safe compare, expiry, type field).
// Future: migrate to `jose` (npm) for battle-tested JOSE compliance and key-rotation support.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from './env'

interface AccessTokenPayload {
  userId: string
  email: string
  role: string
  type: 'access'
  iat: number
  exp: number
}

interface PreAuthTokenPayload {
  userId: string
  email: string
  type: 'pre_auth'
  iat: number
  exp: number
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function signJwt(payload: object, secret: string, expiresInSecs: number): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSecs,
      }),
    ),
  )
  const sig = base64UrlEncode(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

function verifyJwt<T>(token: string, secret: string): T | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = base64UrlEncode(createHmac('sha256', secret).update(`${header}.${body}`).digest())
  try {
    if (!timingSafeEqual(Buffer.from(sig!), Buffer.from(expected))) return null
  } catch {
    return null
  }
  try {
    const payload = JSON.parse(base64UrlDecode(body!).toString()) as T & { exp: number }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, 'type' | 'iat' | 'exp'>,
): string {
  return signJwt({ ...payload, type: 'access' }, env.JWT_SECRET, 15 * 60)
}

export function signPreAuthToken(
  payload: Omit<PreAuthTokenPayload, 'type' | 'iat' | 'exp'>,
): string {
  return signJwt({ ...payload, type: 'pre_auth' }, env.JWT_REFRESH_SECRET, 5 * 60)
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const payload = verifyJwt<AccessTokenPayload>(token, env.JWT_SECRET)
  if (!payload || payload.type !== 'access') return null
  return payload
}

export function verifyPreAuthToken(token: string): PreAuthTokenPayload | null {
  const payload = verifyJwt<PreAuthTokenPayload>(token, env.JWT_REFRESH_SECRET)
  if (!payload || payload.type !== 'pre_auth') return null
  return payload
}
