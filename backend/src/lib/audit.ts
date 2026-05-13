import { db } from './prisma'
import { logger } from './logger'

/**
 * Persist an audit log entry. Shared by admin routes and user-facing flows
 * (deposit-address generation, withdrawal requests, etc.).
 *
 * Writing is best-effort — we never fail the user request just because the
 * audit log couldn't be written, but we log the failure for ops to notice.
 */
export async function recordAuditLog(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId,
        action,
        targetType,
        targetId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: details as any,
      },
    })
  } catch (err) {
    logger.warn({ err, action, targetType, targetId }, 'Failed to write audit log')
  }
}
