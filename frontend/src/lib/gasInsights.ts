// Shared types + helpers for the gas Analytics page and the Payment Orders / Gas Trades summary strips.

export type GasRangeKey = '24h' | '5d' | '7d' | '30d' | 'all' | 'custom'
export const GAS_RANGE_OPTIONS: { key: GasRangeKey; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '5d', label: '5d' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
]
export const DEFAULT_GAS_RANGE: GasRangeKey = '7d'

export type GasCategory = 'crypto' | 'pkr' | 'free' | 'unknown'
export const CATEGORY_LABEL: Record<GasCategory, string> = { crypto: 'Crypto', pkr: 'PKR', free: 'Free Gas', unknown: 'Unknown' }
// One colour per category, reused by every chart so the meaning never shifts between visuals.
export const CATEGORY_COLOR: Record<GasCategory, string> = { crypto: '#2563eb', pkr: '#059669', free: '#d97706', unknown: '#94a3b8' }

export interface Change {
  current: number | null
  previous: number | null
  pct: number | null
  kind: 'pct' | 'new' | 'no_prior' | 'unavailable'
}

interface InsightsMeta {
  from: string | null
  to: string
  prevFrom: string | null
  prevTo: string | null
  hasComparison: boolean
  timeZone: string
  bucket: 'hour' | 'day' | 'week'
  generatedAt: string
  truncated: boolean
}

export interface CategoryRow { category: GasCategory; count: number; share: number | null; delivered: number; change: Change | null }
interface DailyPoint { key: string; crypto: number; pkr: number; free: number; unknown: number; total: number; prevTotal: number | null }
export interface DemandItem { asset: string; chain: string; delivered: number; share: number | null; uniqueUsers: number }
export interface NetworkDelivery { chain: string; delivered: number; failed: number; pending: number; successRate: number | null; avgCompletionSec: number | null }

export interface GasInsights {
  meta: InsightsMeta
  headline: {
    totalOrders: Change
    deliveredOrders: Change
    paidPurchases: Change
    uniqueUsers: Change
    newUsers: Change
    deliverySuccess: {
      rate: number | null; previousRate: number | null; pointChange: number | null
      delivered: number; failed: number; pending: number; denominator: number
    }
  }
  outcomes: { delivered: number; failed: number; pending: number; other: number }
  categories: CategoryRow[]
  freeGas: { delivered: number; uniqueRecipients: number; subsidyUsd: number }
  daily: DailyPoint[]
  demand: { paid: DemandItem[]; free: DemandItem[]; all: DemandItem[] }
  users: {
    daily: { key: string; newUsers: number; returningUsers: number }[]
    registered: { key: string; count: number }[] | null
  }
  delivery: {
    delivered: number; failed: number; pending: number
    successRate: number | null
    avgCompletionSec: number | null
    avgCompletionChange: Change
    failedChange: Change
    byNetwork: NetworkDelivery[]
  }
}

export interface TradesSummary {
  meta: InsightsMeta
  cards: { orders: Change; delivered: Change; uniqueRecipients: Change; freeDelivered: Change }
  categories: CategoryRow[]
  outcomes: { delivered: number; failed: number; pending: number; other: number }
  freeGas: { delivered: number; uniqueRecipients: number; subsidyUsd: number }
  daily: DailyPoint[]
}

export interface PaymentsSummary {
  meta: InsightsMeta
  cards: { paymentOrders: Change; settled: Change; settledCrypto: Change; settledPkr: Change }
  shares: { crypto: number | null; pkr: number | null }
  pendingPayment: number
  daily: { key: string; crypto: number; pkr: number; prevSettled: number | null }[]
}

// ─── Time zone + range resolution ─────────────────────────────────────────────

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function zonedWallClockMs(d: Date, tz: string): number {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(d)) p[part.type] = part.value
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +(p.hour === '24' ? '0' : p.hour!), +p.minute!, +p.second!)
}

/** The UTC instant at which calendar day `dayKey` (YYYY-MM-DD) starts in `tz`. */
function startOfZonedDay(dayKey: string, tz: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d)
  let t = guess - (zonedWallClockMs(new Date(guess), tz) - guess)
  t = guess - (zonedWallClockMs(new Date(t), tz) - t) // second pass settles DST edges
  return new Date(t)
}

function zonedDayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function addDays(dayKey: string, n: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface ResolvedRange { from: string | null; to: string; label: string; days: number | null }

/**
 * Resolve a preset/custom range to inclusive ISO instants in `tz`.
 * Day presets are calendar-aligned (today counts as the last day); 24h is a rolling window.
 */
export function resolveGasRange(range: GasRangeKey, tz: string, custom?: { from?: string | null; to?: string | null }, now: Date = new Date()): ResolvedRange {
  const shortDay = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (range === 'all') return { from: null, to: now.toISOString(), label: 'All time', days: null }
  if (range === '24h') return { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString(), label: 'Last 24 hours', days: 1 }
  if (range === 'custom' && custom?.from && custom?.to && custom.from <= custom.to) {
    const from = startOfZonedDay(custom.from, tz)
    const to = new Date(startOfZonedDay(addDays(custom.to, 1), tz).getTime() - 1)
    const days = Math.round((to.getTime() - from.getTime() + 1) / 86_400_000)
    return { from: from.toISOString(), to: to.toISOString(), label: `${shortDay(custom.from)} – ${shortDay(custom.to)}`, days }
  }
  const n = range === '5d' ? 5 : range === '30d' ? 30 : 7
  const today = zonedDayKey(now, tz)
  const firstKey = addDays(today, -(n - 1))
  const from = startOfZonedDay(firstKey, tz)
  const to = new Date(startOfZonedDay(addDays(today, 1), tz).getTime() - 1)
  return { from: from.toISOString(), to: to.toISOString(), label: `${shortDay(firstKey)} – ${shortDay(today)}`, days: n }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'))
export const fmtShare = (s: number | null | undefined) => (s === null || s === undefined ? '—' : `${(s * 100).toFixed(s > 0 && s < 0.1 ? 1 : 0)}%`)
export const fmtRate = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(r < 1 && r > 0.99 ? 1 : 0)}%`)

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** "Oct 6" / "14:00" / "Wk of Oct 6" from a server bucket key. */
export function fmtBucket(key: string, unit: 'hour' | 'day' | 'week'): string {
  if (unit === 'hour') return key.slice(11)
  const d = new Date(`${key.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return unit === 'week' ? `Wk of ${d}` : d
}

export function fmtUpdated(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
