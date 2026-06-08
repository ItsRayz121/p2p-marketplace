// Auto-lifts expired suspensions and temporary bans.
// Runs on a repeatable schedule (see workers.ts). Each lifted restriction
// records a system ModerationAction (moderatorId = null) and notifies the user.
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { computeModerationStatus, recordModerationAction, notifyModeration } from '../lib/moderation'

export async function runModerationExpiry(): Promise<{ unsuspended: number; unbanned: number }> {
  const now = new Date()

  // Expired suspensions (only those with a deadline that has passed).
  const expiredSuspensions = await db.user.findMany({
    where: { isSuspended: true, suspendedUntil: { not: null, lte: now } },
    select: { id: true, isBanned: true, isSuspended: true, bannedUntil: true, underReview: true },
  })
  for (const u of expiredSuspensions) {
    const prev = computeModerationStatus(u)
    await db.user.update({
      where: { id: u.id },
      data: { isSuspended: false, suspendedUntil: null, ...(u.isBanned ? {} : { moderationReason: null, suspendReason: null }) },
    })
    await recordModerationAction({
      targetUserId: u.id, moderatorId: null, action: 'auto_unsuspend',
      reason: 'Suspension period elapsed', previousStatus: prev,
      newStatus: computeModerationStatus({ ...u, isSuspended: false }),
    })
    notifyModeration(u.id, 'Suspension lifted', 'Your suspension period has ended and full access has been restored.', { action: 'auto_unsuspend' })
  }

  // Expired temporary bans.
  const expiredBans = await db.user.findMany({
    where: { isBanned: true, bannedUntil: { not: null, lte: now } },
    select: { id: true, isBanned: true, isSuspended: true, bannedUntil: true, underReview: true },
  })
  for (const u of expiredBans) {
    const prev = computeModerationStatus(u)
    await db.user.update({
      where: { id: u.id },
      data: { isBanned: false, banType: null, bannedUntil: null, ...(u.isSuspended ? {} : { moderationReason: null, suspendReason: null }) },
    })
    await recordModerationAction({
      targetUserId: u.id, moderatorId: null, action: 'auto_unban',
      reason: 'Temporary ban period elapsed', previousStatus: prev,
      newStatus: computeModerationStatus({ ...u, isBanned: false, bannedUntil: null }),
    })
    notifyModeration(u.id, 'Ban lifted', 'Your temporary ban has ended. You can sign in again.', { action: 'auto_unban' })
  }

  const result = { unsuspended: expiredSuspensions.length, unbanned: expiredBans.length }
  if (result.unsuspended || result.unbanned) {
    logger.info(result, 'Moderation expiry sweep lifted restrictions')
  }
  return result
}
