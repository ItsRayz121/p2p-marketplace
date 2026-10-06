/**
 * Active hours — one availability window per person (trade creator / affiliate),
 * applied to ALL of their ads — plus the admin's "manual verification offline" window.
 *
 * A window is stored as minutes from local midnight in a timezone. start > end wraps
 * midnight (e.g. 22:00 → 06:00). The platform timezone (PlatformConfig `platform_timezone`,
 * default Asia/Karachi) is used when the user has not picked their own.
 */
import { db } from './prisma'

export const PLATFORM_TZ_KEY = 'platform_timezone'
export const DEFAULT_PLATFORM_TZ = 'Asia/Karachi'
/** Admin master switch for creator active hours (default ON; each user still opts in). */
export const ACTIVE_HOURS_ENABLED_KEY = 'active_hours_enabled'

/** Admin "manual verification offline" window (PKR / exchange proofs not checked). */
export const MV_OFFLINE_ENABLED_KEY = 'manual_verify_offline_enabled'
export const MV_OFFLINE_START_KEY = 'manual_verify_offline_start' // "HH:MM"
export const MV_OFFLINE_END_KEY = 'manual_verify_offline_end'     // "HH:MM"
export const MV_OFFLINE_MESSAGE_KEY = 'manual_verify_offline_message'
const DEFAULT_MV_START = '02:00'
const DEFAULT_MV_END = '09:00'

export interface ActiveHoursUser {
  activeHoursEnabled: boolean
  activeHoursStart: number | null
  activeHoursEnd: number | null
  activeHoursTz: string | null
}

export interface Availability {
  /** false only when the user has a window configured and now is outside it. */
  online: boolean
  /** The configured window, for display ("10:00 – 22:00 PKT"). null = always on. */
  hours: { start: string; end: string; tz: string } | null
  /** Human label of the next opening time in the creator's timezone, when offline. */
  opensAt: string | null
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function minutesToHHMM(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function parseHHMM(v: string | null | undefined, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '').trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!
  const h = Math.min(23, Number(m[1]))
  const mi = Math.min(59, Number(m[2]))
  return h * 60 + mi
}

/** Minutes since local midnight for `date` in `tz`. */
export function localMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return (h % 24) * 60 + m
}

/** True when `nowMin` falls inside [start, end), wrapping midnight when start > end. */
export function inWindow(nowMin: number, start: number, end: number): boolean {
  if (start === end) return true // degenerate = 24h
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end
}

export async function getPlatformTimezone(): Promise<string> {
  const row = await db.platformConfig.findUnique({ where: { key: PLATFORM_TZ_KEY } })
  const tz = row?.value?.trim()
  return tz && isValidTimezone(tz) ? tz : DEFAULT_PLATFORM_TZ
}

export async function isActiveHoursFeatureOn(): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key: ACTIVE_HOURS_ENABLED_KEY } })
  return row ? row.value === 'true' || row.value === '1' : true
}

export function tzShortLabel(tz: string): string {
  if (tz === 'Asia/Karachi') return 'PKT'
  return tz
}

/** Pure availability calc (no I/O) — `featureOn` and `platformTz` are resolved by the caller. */
export function computeAvailability(
  u: ActiveHoursUser,
  platformTz: string,
  featureOn: boolean,
  now: Date = new Date(),
): Availability {
  if (!featureOn || !u.activeHoursEnabled || u.activeHoursStart == null || u.activeHoursEnd == null) {
    return { online: true, hours: null, opensAt: null }
  }
  const tz = u.activeHoursTz && isValidTimezone(u.activeHoursTz) ? u.activeHoursTz : platformTz
  const hours = { start: minutesToHHMM(u.activeHoursStart), end: minutesToHHMM(u.activeHoursEnd), tz }
  const online = inWindow(localMinutes(now, tz), u.activeHoursStart, u.activeHoursEnd)
  return { online, hours, opensAt: online ? null : `${hours.start} ${tzShortLabel(tz)}` }
}

const AVAILABILITY_SELECT = { activeHoursEnabled: true, activeHoursStart: true, activeHoursEnd: true, activeHoursTz: true } as const

export async function getUserAvailability(userId: string): Promise<Availability> {
  const [u, platformTz, featureOn] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: AVAILABILITY_SELECT }),
    getPlatformTimezone(),
    isActiveHoursFeatureOn(),
  ])
  if (!u) return { online: true, hours: null, opensAt: null }
  return computeAvailability(u, platformTz, featureOn)
}

export { AVAILABILITY_SELECT }

export interface ManualVerifyStatus {
  offline: boolean
  start: string
  end: string
  tz: string
  /** e.g. "09:00 PKT" — when manual checking resumes. */
  resumesAt: string | null
  message: string
}

/** Is the admin's manual PKR / exchange verification currently offline? */
export async function getManualVerifyStatus(now: Date = new Date()): Promise<ManualVerifyStatus> {
  const rows = await db.platformConfig.findMany({
    where: { key: { in: [MV_OFFLINE_ENABLED_KEY, MV_OFFLINE_START_KEY, MV_OFFLINE_END_KEY, MV_OFFLINE_MESSAGE_KEY] } },
  })
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const tz = await getPlatformTimezone()
  const startStr = minutesToHHMM(parseHHMM(m.get(MV_OFFLINE_START_KEY), DEFAULT_MV_START))
  const endStr = minutesToHHMM(parseHHMM(m.get(MV_OFFLINE_END_KEY), DEFAULT_MV_END))
  const enabled = m.get(MV_OFFLINE_ENABLED_KEY) === 'true'
  const offline = enabled && inWindow(localMinutes(now, tz), parseHHMM(startStr, DEFAULT_MV_START), parseHHMM(endStr, DEFAULT_MV_END))
  const resumesAt = offline ? `${endStr} ${tzShortLabel(tz)}` : null
  const custom = m.get(MV_OFFLINE_MESSAGE_KEY)?.trim()
  const message = custom
    || `Manual payment verification is offline until ${endStr} ${tzShortLabel(tz)}. For instant confirmation pay by blockchain (USDT), or submit your proof now and it will be checked when we're back.`
  return { offline, start: startStr, end: endStr, tz, resumesAt, message }
}
