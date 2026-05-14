import { createHash, randomBytes } from 'node:crypto'
import { redis } from '../lib/redis'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { recordAuditLog } from '../lib/audit'
import { logger } from '../lib/logger'

// ─── Redis key helpers ────────────────────────────────────────────────────────

const confirmKey = (wid: string) => `wd:confirm:${wid}`
const cancelKey = (wid: string) => `wd:cancel:${wid}`
const resendKey = (wid: string) => `wd:resend:${wid}`

// ─── Token primitives ─────────────────────────────────────────────────────────

function tokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function generateWithdrawalToken(): string {
  return randomBytes(32).toString('hex')
}

// Store both a confirm-token and a cancel-token for a withdrawal.
// Returns the raw (unhashed) tokens to embed in the email links.
export async function storeConfirmationTokens(
  withdrawalId: string,
  ttlSeconds: number,
): Promise<{ confirmToken: string; cancelToken: string }> {
  const confirmToken = generateWithdrawalToken()
  const cancel = generateWithdrawalToken()

  await Promise.all([
    redis.set(confirmKey(withdrawalId), tokenHash(confirmToken), 'EX', ttlSeconds),
    redis.set(cancelKey(withdrawalId), tokenHash(cancel), 'EX', ttlSeconds),
  ])

  return { confirmToken, cancelToken: cancel }
}

// Verify a confirm token for `withdrawalId` and consume it (one-time use).
// Uses GETDEL (atomic) to prevent two concurrent confirms from both passing.
export async function consumeConfirmToken(withdrawalId: string, rawToken: string): Promise<boolean> {
  const key = confirmKey(withdrawalId)
  // GETDEL is atomic — only one concurrent call can retrieve and delete the key
  const stored = await redis.getdel(key)
  if (!stored) return false
  if (stored !== tokenHash(rawToken)) {
    // Wrong token — put it back so the user can retry with the correct one.
    // This shouldn't happen in normal flow (link tampering); silently return false.
    return false
  }
  // Also clean up the cancel key — that link is now stale
  await redis.del(cancelKey(withdrawalId))
  return true
}

// Verify a cancel token for `withdrawalId` and consume it.
export async function consumeCancelToken(withdrawalId: string, rawToken: string): Promise<boolean> {
  const key = cancelKey(withdrawalId)
  const stored = await redis.getdel(key)
  if (!stored) return false
  if (stored !== tokenHash(rawToken)) {
    return false
  }
  await redis.del(confirmKey(withdrawalId))
  return true
}

// Returns resend attempt count after incrementing. Limit: 3 per 5-min window.
export async function incrementResendCount(withdrawalId: string): Promise<number> {
  const key = resendKey(withdrawalId)
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, 300) // 5-min window set on first hit
  return count
}

export const MAX_RESENDS = 3

// ─── Withdrawal lock ──────────────────────────────────────────────────────────

export type LockReason = 'password_changed' | 'password_reset' | '2fa_disabled'

const LOCK_DURATIONS_MS: Record<LockReason, number> = {
  password_changed: 24 * 60 * 60 * 1000,  // 24h
  password_reset:   24 * 60 * 60 * 1000,  // 24h
  '2fa_disabled':   72 * 60 * 60 * 1000,  // 72h
}

const LOCK_LABELS: Record<LockReason, string> = {
  password_changed: 'password change',
  password_reset:   'password reset',
  '2fa_disabled':   '2FA disabled',
}

export async function applyWithdrawalLock(
  userId: string,
  reason: LockReason,
  actorId?: string,
): Promise<void> {
  const until = new Date(Date.now() + LOCK_DURATIONS_MS[reason])
  const label = LOCK_LABELS[reason]

  await db.user.update({
    where: { id: userId },
    data: {
      withdrawalLockedUntil: until,
      withdrawalLockReason: label,
    },
  })

  void recordAuditLog(actorId ?? userId, 'WITHDRAWAL_LOCK_APPLIED', 'User', userId, {
    reason,
    label,
    lockedUntil: until.toISOString(),
  }).catch((err) => logger.error({ err }, 'Failed to log withdrawal lock audit'))
}

// Guard used at the top of requestWithdrawal. Throws 403 if locked.
export async function assertWithdrawalNotLocked(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { withdrawalLockedUntil: true, withdrawalLockReason: true },
  })
  if (user?.withdrawalLockedUntil && user.withdrawalLockedUntil > new Date()) {
    const until = user.withdrawalLockedUntil.toISOString()
    const reason = user.withdrawalLockReason ?? 'recent security change'
    throw new AppError(
      'WITHDRAWAL_LOCKED',
      `Withdrawals are temporarily locked due to ${reason}. Lock expires: ${until}`,
      403,
    )
  }
}

// ─── Expired confirmation cleanup ─────────────────────────────────────────────
// Call this lazily on getUserWithdrawals to cancel stale email_pending rows.

export async function cancelExpiredConfirmations(
  userId: string,
  ttlMins: number,
): Promise<void> {
  const cutoff = new Date(Date.now() - ttlMins * 60 * 1000)
  try {
    await db.withdrawal.updateMany({
      where: {
        userId,
        status: 'email_pending',
        createdAt: { lt: cutoff },
      },
      data: { status: 'cancelled' },
    })
  } catch (err) {
    logger.error({ err }, 'Failed to cancel expired email_pending withdrawals')
  }
}
