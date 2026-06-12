/**
 * Gas-order cancellation abuse ladder.
 *
 * Users may cancel a gas order while it is still `payment_pending` and no payment
 * has been claimed. To stop abuse (repeatedly creating + cancelling orders) an
 * escalating cooldown applies, counted over a rolling 7-day window:
 *
 *   cancels 1–2  → free, no penalty
 *   cancel  3    → 6-hour cooldown before a new gas order may be placed
 *   cancel  4+   → 48-hour cooldown
 *
 * Identity is the userId when authenticated, otherwise the client IP for guests.
 * The active cooldown is cached in Redis for fast order-creation checks, and is
 * reconstructable from the GasCancellationEvent log if the cache is lost.
 */

import { db } from '../prisma'
import { redis } from '../redis'
import { logger as log } from '../logger'
import { AppError } from '../errors'

// Rolling window over which prior cancellations count toward the ladder.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
// Cancellations up to this count incur no penalty.
const FREE_CANCELS = 2
const TIER3_COOLDOWN_MS = 6 * 60 * 60 * 1000   // 3rd cancel  → 6 hours
const TIER4_COOLDOWN_MS = 48 * 60 * 60 * 1000  // 4th+ cancel → 48 hours

export interface CancelIdentity {
  identity: string
  userId: string | null
  ipAddress: string | null
}

/** Build the cooldown identity: authenticated userId wins, else the client IP. */
export function gasCancelIdentity(
  userId: string | null | undefined,
  ip: string | null | undefined,
): CancelIdentity {
  if (userId) return { identity: `user:${userId}`, userId, ipAddress: ip ?? null }
  const addr = ip ?? 'unknown'
  return { identity: `ip:${addr}`, userId: null, ipAddress: addr }
}

function cooldownMsForCount(countIncludingThis: number): number {
  if (countIncludingThis <= FREE_CANCELS) return 0
  if (countIncludingThis === FREE_CANCELS + 1) return TIER3_COOLDOWN_MS
  return TIER4_COOLDOWN_MS
}

/** Human-friendly duration for user-facing messages ("6 hours", "2 days"). */
export function humanizeDuration(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000))
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24
    return `${days} day${days > 1 ? 's' : ''}`
  }
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`
  const mins = Math.max(1, Math.round(ms / 60000))
  return `${mins} minute${mins > 1 ? 's' : ''}`
}

const cooldownKey = (identity: string) => `gas_cancel_cooldown:${identity}`

async function countRecentCancels(identity: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS)
  return db.gasCancellationEvent.count({ where: { identity, createdAt: { gte: since } } })
}

export interface CancelPreview {
  priorCancels: number
  thisCancelNumber: number
  cooldownMs: number
  cooldownLabel: string | null
}

/** What would happen if the caller cancelled right now (for the confirm dialog). */
export async function previewCancelPenalty(ident: CancelIdentity): Promise<CancelPreview> {
  const prior = await countRecentCancels(ident.identity)
  const thisNum = prior + 1
  const ms = cooldownMsForCount(thisNum)
  return {
    priorCancels: prior,
    thisCancelNumber: thisNum,
    cooldownMs: ms,
    cooldownLabel: ms > 0 ? humanizeDuration(ms) : null,
  }
}

export interface CancelPenaltyApplied {
  cancelNumber: number
  cooldownMs: number
  cooldownLabel: string | null
  cooldownUntil: string | null
}

/** Record a cancellation event and apply the resulting cooldown. */
export async function recordCancellation(
  ident: CancelIdentity,
  order: { id: string; orderRef: string },
): Promise<CancelPenaltyApplied> {
  await db.gasCancellationEvent.create({
    data: {
      identity: ident.identity,
      userId: ident.userId,
      ipAddress: ident.ipAddress,
      orderId: order.id,
      orderRef: order.orderRef,
    },
  })

  const count = await countRecentCancels(ident.identity)
  const ms = cooldownMsForCount(count)
  let until: string | null = null
  if (ms > 0) {
    until = new Date(Date.now() + ms).toISOString()
    try { await redis.set(cooldownKey(ident.identity), until, 'PX', ms) } catch { /* cache write non-fatal */ }
  }

  log.info(
    { identity: ident.identity, cancelNumber: count, cooldownMs: ms, orderRef: order.orderRef },
    '[gas-cancel] cancellation recorded',
  )
  return { cancelNumber: count, cooldownMs: ms, cooldownLabel: ms > 0 ? humanizeDuration(ms) : null, cooldownUntil: until }
}

/** Active cooldown for an identity, or null. Falls back to the event log on cache miss. */
export async function getActiveCooldown(
  ident: CancelIdentity,
): Promise<{ until: string; remainingMs: number } | null> {
  let cached: string | null = null
  try { cached = await redis.get(cooldownKey(ident.identity)) } catch { /* fall through to DB */ }
  if (cached) {
    const remainingMs = new Date(cached).getTime() - Date.now()
    return remainingMs > 0 ? { until: cached, remainingMs } : null
  }

  // Cache miss (restart/flush) → reconstruct from the event log so the cooldown
  // still holds even when the Redis entry was lost.
  const count = await countRecentCancels(ident.identity)
  const ms = cooldownMsForCount(count)
  if (ms <= 0) return null
  const last = await db.gasCancellationEvent.findFirst({
    where: { identity: ident.identity },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (!last) return null
  const untilTs = last.createdAt.getTime() + ms
  const remainingMs = untilTs - Date.now()
  if (remainingMs <= 0) return null
  return { until: new Date(untilTs).toISOString(), remainingMs }
}

/** Throw a 429 if the identity is currently in a post-cancellation cooldown. */
export async function assertNotInGasCooldown(ident: CancelIdentity): Promise<void> {
  const cd = await getActiveCooldown(ident)
  if (cd) {
    throw new AppError(
      'GAS_CANCEL_COOLDOWN',
      `You've cancelled several recent gas orders. Please wait ${humanizeDuration(cd.remainingMs)} before placing a new one.`,
      429,
    )
  }
}
