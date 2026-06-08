/**
 * Moderation helpers (Admin Audit Phase 1).
 *
 * `isBanned` / `isSuspended` remain the authoritative enforcement flags read by
 * the auth middleware and login. This module derives a richer *status* from
 * those flags + the duration/classification columns, and records an immutable
 * ModerationAction for every change.
 */
import { db } from './prisma'
import { notify } from './notify'

export type ModerationStatus =
  | 'active'
  | 'suspended'
  | 'temporarily_banned'
  | 'permanently_banned'
  | 'under_review'

export interface ModerationFlags {
  isBanned: boolean
  isSuspended: boolean
  bannedUntil: Date | null
  underReview: boolean
}

/** Derive the canonical moderation status from a user's flags. */
export function computeModerationStatus(u: ModerationFlags): ModerationStatus {
  if (u.isBanned) return u.bannedUntil ? 'temporarily_banned' : 'permanently_banned'
  if (u.isSuspended) return 'suspended'
  if (u.underReview) return 'under_review'
  return 'active'
}

const STATUS_LABELS: Record<ModerationStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  temporarily_banned: 'Temporarily Banned',
  permanently_banned: 'Permanently Banned',
  under_review: 'Under Review',
}

export function moderationStatusLabel(s: ModerationStatus): string {
  return STATUS_LABELS[s] ?? s
}

/** Records a ModerationAction row. Never throws into the request path. */
export async function recordModerationAction(params: {
  targetUserId: string
  moderatorId?: string | null
  action: string
  reason: string
  previousStatus: ModerationStatus
  newStatus: ModerationStatus
  durationLabel?: string | null
  expiresAt?: Date | null
}): Promise<void> {
  await db.moderationAction.create({
    data: {
      targetUserId: params.targetUserId,
      moderatorId: params.moderatorId ?? null,
      action: params.action,
      reason: params.reason,
      previousStatus: params.previousStatus,
      newStatus: params.newStatus,
      durationLabel: params.durationLabel ?? null,
      expiresAt: params.expiresAt ?? null,
    },
  })
}

/** Sends an in-app (DB + SSE + push) notification to a moderated user. */
export function notifyModeration(
  userId: string,
  title: string,
  body: string,
  metadata: Record<string, unknown> = {},
): void {
  notify(userId, 'moderation', title, body, metadata, undefined, '/account/restricted')
}
