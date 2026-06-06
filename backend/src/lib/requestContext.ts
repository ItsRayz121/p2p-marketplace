import { AsyncLocalStorage } from 'node:async_hooks'

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

/**
 * Resolve the real client IP, preferring proxy headers set by Cloudflare /
 * Railway over the raw socket. `fallback` is typically Fastify's req.ip
 * (already X-Forwarded-For aware when trustProxy is enabled).
 */
export function resolveClientIp(
  headers: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  const cf = headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xr = headers['x-real-ip']
  if (typeof xr === 'string' && xr.trim()) return xr.trim()
  const xff = headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0]!.trim()
  return fallback
}
