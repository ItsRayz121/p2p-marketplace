import IORedis from 'ioredis'
import { env } from './env'
import { logger } from './logger'

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
})

redis.on('connect', () => logger.info('Redis connected'))
redis.on('error', (err) => logger.error({ err }, 'Redis error'))
redis.on('reconnecting', () => logger.warn('Redis reconnecting'))

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit()
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
