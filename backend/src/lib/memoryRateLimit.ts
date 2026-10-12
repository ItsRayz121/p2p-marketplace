/**
 * Per-process fallback rate limiter, used ONLY while the shared Redis limiter is unavailable.
 *
 * @fastify/rate-limit is configured with skipOnError, so when Redis is down it silently stops
 * limiting. For auth, money and other expensive endpoints that is the wrong default. This keeps a
 * conservative in-memory window in the meantime. It is per process, so the aggregate allowance is
 * (limit x number of workers); the limits below are tight enough that this still bounds abuse.
 */

export interface MemoryLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

const MAX_KEYS = 50_000

export class MemoryRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  private lastSweep = 0

  constructor(private readonly windowMs = 60_000) {}

  hit(key: string, max: number, now = Date.now()): MemoryLimitResult {
    // Full: reclaim expired keys, but at most once a second so a flood of distinct keys cannot make
    // every insert an O(n) scan.
    if (this.hits.size >= MAX_KEYS && now - this.lastSweep >= 1_000) {
      this.lastSweep = now
      this.evictExpired(now)
    }
    // Still full of live keys: drop the oldest rather than grow forever.
    if (this.hits.size >= MAX_KEYS) {
      const oldest = this.hits.keys().next().value
      if (oldest !== undefined) this.hits.delete(oldest)
    }
    const cur = this.hits.get(key)
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true, retryAfterSeconds: 0 }
    }
    cur.count += 1
    if (cur.count > max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  private evictExpired(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }

  get size(): number {
    return this.hits.size
  }
}

// Auth, OTP/email-sending, money movement, uploads and gas-order creation. Everything else gets the
// general allowance.
const SENSITIVE_PATH =
  /^\/api\/v1\/(auth\/|wallet\/(withdraw|unlock|lock)|gas-fee\/(orders|custom-request)|upload\/|instant-buy\/orders|admin\/)/

export const FALLBACK_LIMITS = {
  sensitive: 20,
  write: 120,
  read: 600,
} as const

/** Which fallback budget applies to this request. Pure, so it can be tested. */
export function fallbackBudget(method: string, pathname: string): { cls: 's' | 'w' | 'r'; max: number } {
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if (!isRead && SENSITIVE_PATH.test(pathname)) return { cls: 's', max: FALLBACK_LIMITS.sensitive }
  if (!isRead) return { cls: 'w', max: FALLBACK_LIMITS.write }
  return { cls: 'r', max: FALLBACK_LIMITS.read }
}
