import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'

/**
 * Per-request context propagated via AsyncLocalStorage so deep service-layer
 * code (e.g. recordAuditLog) can access the caller's IP / user-agent without
 * threading them through every function signature.
 *
 * Set once in an onRequest hook (see app.ts). Background jobs run outside any
 * request, so getStore() returns undefined and audit entries fall back to
 * "Not captured" — which is correct (there is no client IP for a cron job).
 */
export interface RequestContext {
  ip?: string | undefined
  userAgent?: string | undefined
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore()
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Resolve the real client IP, preferring proxy headers set by Cloudflare /
 * Railway over the raw socket. `fallback` is typically Fastify's req.ip.
 *
 * Production topology (confirmed from live logs): client -> Cloudflare -> Railway proxy -> app.
 * Cloudflare overwrites CF-Connecting-IP, so it is the reliable client address; Fastify's own
 * req.ip is only a Cloudflare edge address there.
 *
 * CF-Connecting-IP / X-Real-IP / X-Forwarded-For are plain request headers, so a caller that reaches
 * the origin WITHOUT going through Cloudflare (for example via the *.up.railway.app domain) can set
 * them to anything. When EDGE_SHARED_SECRET is configured (a Cloudflare Transform Rule adds the same
 * value as an `X-Edge-Secret` request header), those headers are honoured only for requests that
 * carry it; anything else is attributed to the last X-Forwarded-For entry, which the proxy nearest to
 * us appended and the caller cannot forge. Unset (the default) keeps the previous behaviour.
 */
export function resolveClientIp(
  headers: Record<string, unknown>,
  fallback?: string,
  edgeSecret: string | undefined = process.env.EDGE_SHARED_SECRET || undefined,
): string | undefined {
  const xff = headers['x-forwarded-for']
  const xffList = typeof xff === 'string' ? xff.split(',').map((s) => s.trim()).filter(Boolean) : []

  if (edgeSecret) {
    const presented = headers['x-edge-secret']
    const throughEdge = typeof presented === 'string' && constantTimeEquals(presented, edgeSecret)
    if (!throughEdge) return xffList.length > 0 ? xffList[xffList.length - 1] : fallback
  }

  const cf = headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xr = headers['x-real-ip']
  if (typeof xr === 'string' && xr.trim()) return xr.trim()
  if (xffList.length > 0) return xffList[0]
  return fallback
}
