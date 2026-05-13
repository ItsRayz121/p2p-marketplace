import IORedis from 'ioredis'
import { env } from './env'
import { logger } from './logger'

// BullMQ requires maxRetriesPerRequest: null — do NOT share this with other Redis users
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
})

redis.on('connect', () => logger.info('Redis connected'))
redis.on('error', (err) => logger.error({ err }, 'Redis error'))
redis.on('reconnecting', () => logger.warn('Redis reconnecting'))

// Separate connection for rate limiting — standard retry behaviour so errors
// surface quickly instead of hanging indefinitely (BullMQ needs null retries,
// rate-limit does not).
export const rateLimitRedis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  lazyConnect: true,
})

rateLimitRedis.on('error', (err) => logger.error({ err }, 'Rate-limit Redis error'))

export async function connectRedis(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connect' || redis.status === 'connecting') return
  await redis.connect()
  if (rateLimitRedis.status !== 'ready' && rateLimitRedis.status !== 'connect' && rateLimitRedis.status !== 'connecting') {
    await rateLimitRedis.connect().catch((err) => logger.error({ err }, 'Rate-limit Redis connect failed'))
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit()
  await rateLimitRedis.quit().catch(() => {})
}

/**
 * Redis key namespaces — all keys must follow this pattern to prevent collisions.
 *
 * Namespaces (from FULL_SPEC.md Section 32 / DB_TRANSACTION_RULES.md Section 7):
 */
export const redisKeys = {
  rate: (coin: string) => `rate:${coin}`,
  idempotency: (key: string) => `idempotency:${key}`,
  leaderboard: (period: string) => `leaderboard:traders:${period}`,
  rateLimit: (endpoint: string, ip: string) => `ratelimit:${endpoint}:${ip}`,
  jobProcessed: (jobId: string) => `job_processed:${jobId}`,
  webhookEvent: (eventId: string) => `webhook_event:${eventId}`,
  resubmitAttempts: (orderId: string) => `resubmit_attempts:${orderId}`,
  gasSent: (orderId: string) => `gas_sent:${orderId}`,
  guestSpend: (ip: string, date: string) => `guest_spend:${ip}:${date}`,
  gasDestOrders: (address: string, date: string) => `gas_dest:${address}:${date}`,
  processingLock: (entityId: string) => `processing:${entityId}`,
} as const
