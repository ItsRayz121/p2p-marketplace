/**
 * Gas analytics aggregation — pure functions over order rows (no I/O) so every
 * metric definition is unit-testable. The routes in adminGasInsights.routes.ts
 * load the rows and call into this module.
 *
 * Three dimensions are deliberately kept apart:
 *   - order category  : crypto | pkr | free | unknown  (mutually exclusive, ALL orders)
 *   - payment method  : crypto | pkr                   (only orders a customer paid for)
 *   - gas received    : token symbol + network         (what was delivered)
 */

export type GasCategory = 'crypto' | 'pkr' | 'free' | 'unknown'
export const GAS_CATEGORIES: readonly GasCategory[] = ['crypto', 'pkr', 'free', 'unknown']

export interface InsightOrderRow {
  id: string
  userId: string | null
  toAddress: string
  chain: string
  tokenSymbol: string | null
  isFreeGrant: boolean
  paymentCoin: string
  paymentNetwork: string
  status: string
  retryCount: number
  paymentTxHash: string | null
  failureReason: string | null
  deliveryTxHash: string | null
  gasAmountUSD: number
  createdAt: Date
  deliveredAt: Date | null
  paymentVerifiedAt: Date | null
  updatedAt: Date
}

export interface Window {
  /** Inclusive start; null = unbounded (All time). */
  from: Date | null
  /** Inclusive end. */
  to: Date
}

export type BucketUnit = 'hour' | 'day' | 'week'

// ─── Classification ───────────────────────────────────────────────────────────

/** Free grants are their own category; PKR vs crypto is the funding rail; blank coin = unknown. */
export function classifyCategory(r: Pick<InsightOrderRow, 'isFreeGrant' | 'paymentCoin'>): GasCategory {
  if (r.isFreeGrant) return 'free'
  const coin = (r.paymentCoin ?? '').trim()
  if (!coin) return 'unknown'
  return coin.toUpperCase() === 'PKR' ? 'pkr' : 'crypto'
}

const SETTLED_STATUSES = new Set([
  'payment_verified', 'payment_detected', 'sending', 'delivered',
  'awaiting_refund', 'refund_pending', 'refunded',
])
const IN_FLIGHT_STATUSES = new Set([
  'created', 'payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending',
])
const NATIVE_SYMBOL: Record<string, string> = {
  TRON: 'TRX', BSC: 'BNB', ETH: 'ETH', SOL: 'SOL', MATIC: 'POL', ARB: 'ETH', BASE: 'ETH',
  OP: 'ETH', AVAX: 'AVAX', TON: 'TON', SUI: 'SUI', APT: 'APT', OPBNB: 'BNB',
}

/** A customer payment was accepted (never true for free grants). */
export function isSettled(r: InsightOrderRow): boolean {
  if (r.isFreeGrant) return false
  if (r.paymentVerifiedAt) return true
  if (SETTLED_STATUSES.has(r.status)) return true
  // A 'failed' order only counts as paid when payment was demonstrably accepted
  // (mirrors PAID_FAILED_WHERE in gas.orderStates.ts).
  return r.status === 'failed'
    && (r.retryCount > 0 || !!r.paymentTxHash || (r.failureReason ?? '').startsWith('refund_skipped'))
}

export type DeliveryOutcome = 'delivered' | 'failed' | 'pending' | 'none'

/**
 * delivered : gas confirmed delivered.
 * failed    : delivery was attempted/owed and ended without gas (failed after payment,
 *             or in the refund lifecycle). Expiry/cancellation BEFORE payment is not a
 *             delivery failure ('none').
 * pending   : still in flight.
 */
export function deliveryOutcome(r: InsightOrderRow): DeliveryOutcome {
  if (r.status === 'delivered') return 'delivered'
  if (r.status === 'awaiting_refund' || r.status === 'refund_pending' || r.status === 'refunded') {
    return r.deliveryTxHash ? 'none' : 'failed'
  }
  if (r.status === 'failed') return isSettled(r) ? 'failed' : 'none'
  if (IN_FLIGHT_STATUSES.has(r.status)) return 'pending'
  return 'none'
}

/** Recipient identity: the account when known, otherwise the destination address. */
export function recipientKey(r: Pick<InsightOrderRow, 'userId' | 'toAddress'>): string {
  if (r.userId) return `u:${r.userId}`
  return `a:${normalizeAddress(r.toAddress)}`
}
export function recipientKeyFromParts(userId: string | null, toAddress: string): string {
  return recipientKey({ userId, toAddress })
}
function normalizeAddress(a: string): string {
  return a.startsWith('0x') || a.startsWith('0X') ? a.toLowerCase() : a
}

export function deliveryDate(r: InsightOrderRow): Date | null {
  if (r.status !== 'delivered') return null
  return r.deliveredAt ?? r.updatedAt
}

function gasAssetLabel(r: Pick<InsightOrderRow, 'tokenSymbol' | 'chain'>): string {
  return r.tokenSymbol ?? NATIVE_SYMBOL[r.chain] ?? r.chain
}

// ─── Timezone-aware bucketing ─────────────────────────────────────────────────

export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC'
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz } catch { return 'UTC' }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    })
    fmtCache.set(tz, f)
  }
  return f
}

function zonedParts(d: Date, tz: string): { day: string; hour: string } {
  const p: Record<string, string> = {}
  for (const part of formatter(tz).formatToParts(d)) p[part.type] = part.value
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour === '24' ? '00' : (p.hour ?? '00') }
}

function addDaysKey(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function weekStartKey(dayKey: string): string {
  const dow = new Date(`${dayKey}T00:00:00Z`).getUTCDay() // 0 = Sunday
  return addDaysKey(dayKey, -((dow + 6) % 7))             // back to Monday
}

export function bucketKey(d: Date, tz: string, unit: BucketUnit): string {
  const { day, hour } = zonedParts(d, tz)
  if (unit === 'hour') return `${day} ${hour}:00`
  if (unit === 'week') return weekStartKey(day)
  return day
}

export function pickBucketUnit(spanMs: number): BucketUnit {
  const DAY = 86_400_000
  if (spanMs <= 2 * DAY) return 'hour'
  if (spanMs <= 120 * DAY) return 'day'
  return 'week'
}

/** Every bucket key from `from` to `to`, in order, zero activity included. */
export function bucketKeys(from: Date, to: Date, tz: string, unit: BucketUnit): string[] {
  const keys: string[] = []
  if (unit === 'hour') {
    for (let t = from.getTime(); t <= to.getTime(); t += 3_600_000) {
      const k = bucketKey(new Date(t), tz, 'hour')
      if (keys[keys.length - 1] !== k && !keys.includes(k)) keys.push(k)
    }
    const last = bucketKey(to, tz, 'hour')
    if (!keys.includes(last)) keys.push(last)
    return keys
  }
  const step = unit === 'week' ? 7 : 1
  const first = bucketKey(from, tz, unit)
  const last = bucketKey(to, tz, unit)
  for (let k = first; k <= last && keys.length < 1000; k = addDaysKey(k, step)) keys.push(k)
  return keys
}

// ─── Change helpers ───────────────────────────────────────────────────────────

export interface Change {
  current: number | null
  previous: number | null
  /** 100 × (current − previous) / previous. */
  pct: number | null
  /** 'new' = zero baseline with activity now; 'no_prior' = zero in both periods. */
  kind: 'pct' | 'new' | 'no_prior' | 'unavailable'
}

export function change(current: number | null, previous: number | null): Change {
  if (current === null || previous === null) return { current, previous, pct: null, kind: 'unavailable' }
  if (previous === 0) return { current, previous, pct: null, kind: current > 0 ? 'new' : 'no_prior' }
  return { current, previous, pct: (100 * (current - previous)) / previous, kind: 'pct' }
}

// ─── Cohort summary ───────────────────────────────────────────────────────────

export interface CohortSummary {
  total: number
  byCategory: Record<GasCategory, number>
  delivered: number
  deliveredByCategory: Record<GasCategory, number>
  paidPurchases: number
  failedDelivery: number
  pending: number
  other: number
  /** Distinct recipients across delivered cohort orders. */
  uniqueRecipients: number
  freeGas: { delivered: number; uniqueRecipients: number; subsidyUsd: number }
  successRate: number | null
  avgCompletionSec: number | null
}

const zeroCats = (): Record<GasCategory, number> => ({ crypto: 0, pkr: 0, free: 0, unknown: 0 })

/** Summarise a creation cohort. Each row is a distinct gas order, so retries/attempts never double count. */
export function summarizeCohort(rows: InsightOrderRow[]): CohortSummary {
  const s: CohortSummary = {
    total: rows.length, byCategory: zeroCats(), delivered: 0, deliveredByCategory: zeroCats(),
    paidPurchases: 0, failedDelivery: 0, pending: 0, other: 0, uniqueRecipients: 0,
    freeGas: { delivered: 0, uniqueRecipients: 0, subsidyUsd: 0 }, successRate: null, avgCompletionSec: null,
  }
  const recipients = new Set<string>()
  const freeRecipients = new Set<string>()
  let completionMs = 0
  let completionN = 0
  for (const r of rows) {
    const cat = classifyCategory(r)
    s.byCategory[cat]++
    const out = deliveryOutcome(r)
    if (out === 'delivered') {
      s.delivered++
      s.deliveredByCategory[cat]++
      recipients.add(recipientKey(r))
      if ((cat === 'crypto' || cat === 'pkr') && isSettled(r)) s.paidPurchases++
      if (cat === 'free') {
        s.freeGas.delivered++
        s.freeGas.subsidyUsd += r.gasAmountUSD
        freeRecipients.add(recipientKey(r))
      }
      if (r.deliveredAt) { completionMs += r.deliveredAt.getTime() - r.createdAt.getTime(); completionN++ }
    } else if (out === 'failed') s.failedDelivery++
    else if (out === 'pending') s.pending++
    else s.other++
  }
  s.uniqueRecipients = recipients.size
  s.freeGas.uniqueRecipients = freeRecipients.size
  const denom = s.delivered + s.failedDelivery
  s.successRate = denom > 0 ? s.delivered / denom : null
  s.avgCompletionSec = completionN > 0 ? Math.round(completionMs / completionN / 1000) : null
  return s
}

export function inWindow(d: Date, w: Window): boolean {
  return (w.from === null || d >= w.from) && d <= w.to
}

export function previousWindow(w: Window): Window | null {
  if (!w.from) return null
  const span = w.to.getTime() - w.from.getTime() + 1
  return { from: new Date(w.from.getTime() - span), to: new Date(w.from.getTime() - 1) }
}

export function shareOf(count: number, total: number): number | null {
  return total > 0 ? count / total : null
}

// ─── Daily series ─────────────────────────────────────────────────────────────

export interface DailyActivityPoint {
  key: string
  crypto: number; pkr: number; free: number; unknown: number
  total: number
  /** Same-index bucket of the previous equal-length period (null when no comparison). */
  prevTotal: number | null
}

export function dailyActivity(
  cur: InsightOrderRow[], prev: InsightOrderRow[], w: Window, pw: Window | null, tz: string, unit: BucketUnit,
): DailyActivityPoint[] {
  const from = w.from ?? cur.reduce<Date>((m, r) => (r.createdAt < m ? r.createdAt : m), w.to)
  const keys = bucketKeys(from, w.to, tz, unit)
  const idx = new Map(keys.map((k, i) => [k, i]))
  const pts: DailyActivityPoint[] = keys.map((key) => ({ key, crypto: 0, pkr: 0, free: 0, unknown: 0, total: 0, prevTotal: pw ? 0 : null }))
  for (const r of cur) {
    const i = idx.get(bucketKey(r.createdAt, tz, unit))
    if (i === undefined) continue
    const p = pts[i]!
    p[classifyCategory(r)]++
    p.total++
  }
  if (pw && pw.from) {
    const pkeys = bucketKeys(pw.from, pw.to, tz, unit)
    const pidx = new Map(pkeys.map((k, i) => [k, i]))
    for (const r of prev) {
      const j = pidx.get(bucketKey(r.createdAt, tz, unit))
      if (j === undefined || j >= pts.length) continue
      pts[j]!.prevTotal = (pts[j]!.prevTotal ?? 0) + 1
    }
  }
  return pts
}

// ─── Demand ───────────────────────────────────────────────────────────────────

export type DemandScope = 'paid' | 'free' | 'all'
export interface DemandItem { asset: string; chain: string; delivered: number; share: number | null; uniqueUsers: number }

/** Gas products ranked by delivered count. Token + network are one identity (ETH on Base ≠ ETH on Ethereum). */
export function demandByAsset(cohort: InsightOrderRow[], scope: DemandScope): DemandItem[] {
  const groups = new Map<string, { asset: string; chain: string; n: number; users: Set<string> }>()
  let total = 0
  for (const r of cohort) {
    if (deliveryOutcome(r) !== 'delivered') continue
    const cat = classifyCategory(r)
    const paid = (cat === 'crypto' || cat === 'pkr') && isSettled(r)
    if (scope === 'paid' && !paid) continue
    if (scope === 'free' && cat !== 'free') continue
    const asset = gasAssetLabel(r)
    const k = `${asset}|${r.chain}`
    let g = groups.get(k)
    if (!g) { g = { asset, chain: r.chain, n: 0, users: new Set() }; groups.set(k, g) }
    g.n++
    g.users.add(recipientKey(r))
    total++
  }
  return [...groups.values()]
    .map((g) => ({ asset: g.asset, chain: g.chain, delivered: g.n, share: shareOf(g.n, total), uniqueUsers: g.users.size }))
    .sort((a, b) => b.delivered - a.delivered)
}

// ─── Users ────────────────────────────────────────────────────────────────────

export interface UserPoint { key: string; newUsers: number; returningUsers: number }

/**
 * `deliveries` are delivered rows whose delivery date falls in the window;
 * `firstEver` maps recipient → first delivery ever. A recipient is "new" in the
 * bucket holding their first-ever delivery, "returning" in any later bucket.
 * Daily distinct users are NOT summed into a period total.
 */
export function userSeries(
  deliveries: InsightOrderRow[], firstEver: Map<string, Date>, w: Window, tz: string, unit: BucketUnit,
): UserPoint[] {
  const from = w.from ?? deliveries.reduce<Date>((m, r) => { const d = deliveryDate(r)!; return d < m ? d : m }, w.to)
  const keys = bucketKeys(from, w.to, tz, unit)
  const per = new Map<string, { newU: Set<string>; retU: Set<string> }>(keys.map((k) => [k, { newU: new Set(), retU: new Set() }]))
  for (const r of deliveries) {
    const d = deliveryDate(r)
    if (!d) continue
    const b = bucketKey(d, tz, unit)
    const slot = per.get(b)
    if (!slot) continue
    const rk = recipientKey(r)
    const first = firstEver.get(rk)
    if (first && bucketKey(first, tz, unit) === b) slot.newU.add(rk)
    else slot.retU.add(rk)
  }
  return keys.map((key) => ({ key, newUsers: per.get(key)!.newU.size, returningUsers: per.get(key)!.retU.size }))
}

export function userTotals(deliveries: InsightOrderRow[], firstEver: Map<string, Date>, w: Window): { unique: number; newUsers: number } {
  const uniq = new Set<string>()
  for (const r of deliveries) {
    const d = deliveryDate(r)
    if (d && inWindow(d, w)) uniq.add(recipientKey(r))
  }
  let n = 0
  for (const d of firstEver.values()) if (inWindow(d, w)) n++
  return { unique: uniq.size, newUsers: n }
}

// ─── Delivery by network ──────────────────────────────────────────────────────

export interface NetworkDelivery { chain: string; delivered: number; failed: number; pending: number; successRate: number | null; avgCompletionSec: number | null }

export function deliveryByNetwork(cohort: InsightOrderRow[]): NetworkDelivery[] {
  const per = new Map<string, InsightOrderRow[]>()
  for (const r of cohort) {
    const arr = per.get(r.chain)
    if (arr) arr.push(r); else per.set(r.chain, [r])
  }
  return [...per.entries()]
    .map(([chain, rs]) => {
      const s = summarizeCohort(rs)
      return { chain, delivered: s.delivered, failed: s.failedDelivery, pending: s.pending, successRate: s.successRate, avgCompletionSec: s.avgCompletionSec }
    })
    .filter((n) => n.delivered + n.failed + n.pending > 0)
    .sort((a, b) => b.delivered + b.failed - (a.delivered + a.failed))
}

// ─── Payments (Payment Orders page) ───────────────────────────────────────────

export interface PaymentsSummary {
  paymentOrders: number
  settled: number
  settledCrypto: number
  settledPkr: number
  pendingPayment: number
}

/** Free grants are excluded: they are not payments. */
export function summarizePayments(rows: InsightOrderRow[]): PaymentsSummary {
  const s: PaymentsSummary = { paymentOrders: 0, settled: 0, settledCrypto: 0, settledPkr: 0, pendingPayment: 0 }
  for (const r of rows) {
    const cat = classifyCategory(r)
    if (cat === 'free') continue
    s.paymentOrders++
    if (isSettled(r)) {
      s.settled++
      if (cat === 'crypto') s.settledCrypto++
      else if (cat === 'pkr') s.settledPkr++
    } else if (r.status === 'created' || r.status === 'payment_pending' || r.status === 'payment_uploaded') s.pendingPayment++
  }
  return s
}

export interface PaymentsDailyPoint { key: string; crypto: number; pkr: number; prevSettled: number | null }

export function dailySettled(
  cur: InsightOrderRow[], prev: InsightOrderRow[], w: Window, pw: Window | null, tz: string, unit: BucketUnit,
): PaymentsDailyPoint[] {
  const from = w.from ?? cur.reduce<Date>((m, r) => (r.createdAt < m ? r.createdAt : m), w.to)
  const keys = bucketKeys(from, w.to, tz, unit)
  const idx = new Map(keys.map((k, i) => [k, i]))
  const pts: PaymentsDailyPoint[] = keys.map((key) => ({ key, crypto: 0, pkr: 0, prevSettled: pw ? 0 : null }))
  for (const r of cur) {
    const cat = classifyCategory(r)
    if ((cat !== 'crypto' && cat !== 'pkr') || !isSettled(r)) continue
    const i = idx.get(bucketKey(r.createdAt, tz, unit))
    if (i !== undefined) pts[i]![cat]++
  }
  if (pw && pw.from) {
    const pkeys = bucketKeys(pw.from, pw.to, tz, unit)
    const pidx = new Map(pkeys.map((k, i) => [k, i]))
    for (const r of prev) {
      const cat = classifyCategory(r)
      if ((cat !== 'crypto' && cat !== 'pkr') || !isSettled(r)) continue
      const j = pidx.get(bucketKey(r.createdAt, tz, unit))
      if (j !== undefined && j < pts.length) pts[j]!.prevSettled = (pts[j]!.prevSettled ?? 0) + 1
    }
  }
  return pts
}
