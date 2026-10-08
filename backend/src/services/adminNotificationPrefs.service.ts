import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import {
  GROUP_META, NOTIF_GROUPS, defaultPrefs, mutedInAppGroups, normalizePrefs,
  type ChannelPrefs, type GroupPrefs, type NotifGroup,
} from '../lib/adminNotifGroups'

/**
 * Per-admin notification delivery preferences. Always keyed by the authenticated admin's own id —
 * there is deliberately no API to read or write another admin's preferences.
 */

export async function getAdminPrefs(userId: string): Promise<GroupPrefs> {
  const row = await db.adminNotificationPreference.findUnique({ where: { userId }, select: { prefs: true } })
  return normalizePrefs(row?.prefs)
}

/** Several admins at once (external fan-out). Admins without a row get the defaults. */
export async function getPrefsForUsers(userIds: string[]): Promise<Map<string, GroupPrefs>> {
  const out = new Map<string, GroupPrefs>(userIds.map((id) => [id, defaultPrefs()]))
  if (userIds.length === 0) return out
  const rows = await db.adminNotificationPreference.findMany({ where: { userId: { in: userIds } }, select: { userId: true, prefs: true } })
  for (const r of rows) out.set(r.userId, normalizePrefs(r.prefs))
  return out
}

export async function saveAdminPrefs(
  userId: string,
  patch: Partial<Record<NotifGroup, { [K in keyof ChannelPrefs]?: boolean | undefined }>>,
): Promise<GroupPrefs> {
  const current = await getAdminPrefs(userId)
  for (const g of NOTIF_GROUPS) {
    const p = patch[g]
    if (!p) continue
    for (const k of ['inApp', 'push', 'telegram', 'sound'] as const) if (typeof p[k] === 'boolean') current[g][k] = p[k]!
  }
  // Mandatory groups keep in-app delivery no matter what was sent.
  for (const g of NOTIF_GROUPS) if (GROUP_META[g].mandatoryInApp) current[g].inApp = true
  const prefs = { groups: current } as unknown as Prisma.InputJsonValue
  await db.adminNotificationPreference.upsert({
    where: { userId },
    create: { userId, prefs },
    update: { prefs },
  })
  return current
}

export async function resetAdminPrefs(userId: string): Promise<GroupPrefs> {
  await db.adminNotificationPreference.deleteMany({ where: { userId } })
  return defaultPrefs()
}

/** Prisma where-fragment hiding the groups this admin has muted for in-app delivery. */
export async function visibleNotifFilter(userId: string): Promise<Prisma.AdminNotificationWhereInput> {
  const muted = mutedInAppGroups(await getAdminPrefs(userId))
  if (muted.length === 0) return {}
  // Legacy rows with no bucket stay visible (the migration backfills them, so this is only a safety net).
  return { OR: [{ prefGroup: null }, { prefGroup: { notIn: muted } }] }
}
