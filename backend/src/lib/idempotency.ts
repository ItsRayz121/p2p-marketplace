import { AppError } from './errors'

/** The slice of the Redis client the idempotency helpers need (lets tests pass a fake). */
export interface IdempotencyRedis {
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<unknown>
  del(key: string): Promise<unknown>
}

const MAX_KEY_LEN = 128

/**
 * Normalise a client-supplied idempotency key. Keys are caller-controlled, so
 * they are length-capped and restricted to a safe charset before they are used
 * to build a Redis key.
 */
export function normalizeIdempotencyKey(raw: string): string {
  const key = (raw ?? '').trim()
  if (!key || key.length > MAX_KEY_LEN || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'X-Idempotency-Key must be 1-128 characters: letters, digits, . _ : -',
      400,
    )
  }
  return key
}

/**
 * Redis key for a user's idempotent action. Scoped by user so one account can
 * never replay (or read back) another account's cached response by reusing its key.
 */
export function idempotencyKeyFor(action: string, userId: string, key: string): string {
  return `idempotency:${action}:${userId}:${key}`
}

/**
 * Run `fn` at most once at a time per key. Two concurrent requests carrying the
 * same key used to both pass a plain GET-then-SET check and each create a
 * withdrawal; this takes an atomic SET NX in-flight lock first, so the second
 * request gets a 409 instead. The lock is always released, and expires on its own
 * if the process dies mid-request.
 */
export async function withInFlightLock<T>(
  redis: IdempotencyRedis,
  lockKey: string,
  fn: () => Promise<T>,
  ttlSeconds = 60,
): Promise<T> {
  const acquired = await redis.set(`${lockKey}:lock`, '1', 'EX', ttlSeconds, 'NX')
  if (acquired !== 'OK') {
    throw new AppError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is already being processed',
      409,
    )
  }
  try {
    return await fn()
  } finally {
    await redis.del(`${lockKey}:lock`).catch(() => {})
  }
}
