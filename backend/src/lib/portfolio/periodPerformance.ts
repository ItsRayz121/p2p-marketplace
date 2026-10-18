import { D } from './decimal'
import { computePosition, type AssetPosition, type TradeEvent } from './fifo'
import type { Quote } from './currency'
import { convertEvents, type EventRow } from './summaryBuilder'
import type { PeriodStats, SeriesPoint } from './performance'
import { snapshotValueIn } from './snapshot'

/**
 * The value-over-time series and period results for an account in a tracking period.
 *
 * The series is made of the points that were really observed and stored (snapshots) plus, for "now", the
 * live valuation the headline uses: nothing before the cutover is drawn, no gap is filled, a value that could
 * not be determined stays null. Cost and realized profit at each point come from the entries up to that
 * moment, continuing from the opening baseline's ACTUAL cost.
 */

export interface StoredPoint {
  takenAt: Date
  valuePkr: string | null
  fxUsdtPkr: string | null
  heldCount: number
  pricedCount: number
}

export interface TrackingInfo {
  version: number
  startedAt: string
  timezone: string
  /** The cutover day is today (in the business timezone): a single observation is normal. */
  startedToday: boolean
  /** Points with a known value inside the requested range. */
  observations: number
  /** Opening MARKET value in the reporting currency (null unless every held token had a valid quote that day). */
  openingMarketValue: string | null
}

export interface PeriodPerformanceResult {
  currency: Quote
  from: string
  to: string
  points: SeriesPoint[]
  period: PeriodStats
  fxUnavailableAssets: string[]
  tracking: TrackingInfo
}

/** At most this many stored points are drawn (always the first and the last); each needs its own cost/realized calculation. */
export const MAX_CHART_POINTS = 120

/** Evenly spaced pick of `items`, keeping the first and the last. */
export function thin<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!)
  return out
}

export const OPENING_ROW_PREFIX = 'open:'
/** A stored point is only used as the value "at" a moment if it was taken this close to it. */
export const SNAPSHOT_TOLERANCE_MS = 12 * 60 * 60 * 1000

const out = (d: InstanceType<typeof D>) => d.toFixed()
const ms = (iso: string) => Date.parse(iso)
const isOpeningRow = (id: string) => id.startsWith(OPENING_ROW_PREFIX)

export function computePeriodPerformance(args: {
  /** The current dataset (opening baseline + entries of the period) for `currency`. */
  rows: EventRow[]
  snapshots: StoredPoint[]
  currency: Quote
  version: number
  startedAt: Date
  timezone: string
  startedToday: boolean
  from?: Date
  to?: Date
  now: Date
  /** The live valuation at `now` in `currency` (what the headline shows); value null = not every token had a quote. */
  live: { value: string | null; priced: number; held: number }
  openingMarketValue: string | null
}): PeriodPerformanceResult {
  const { currency, now } = args
  const startedMs = args.startedAt.getTime()
  const nowMs = now.getTime()
  // The browser sends its own "now" as the end of the range; anything within a few minutes of the server's clock means "up to now".
  const nearNow = args.to === undefined || args.to.getTime() >= nowMs - 5 * 60_000
  const toMs = nearNow ? nowMs : args.to!.getTime()
  const fromMs = Math.max(args.from?.getTime() ?? startedMs, startedMs) // never before tracking began
  if (fromMs > toMs) throw new Error('invalid range')

  const { events, unavailable } = convertEvents(args.rows, currency, { keepUnknownCost: true })
  const byAsset = new Map<string, TradeEvent[]>()
  for (const e of events) byAsset.set(e.assetId, [...(byAsset.get(e.assetId) ?? []), e])

  const positionsAt = (tMs: number): AssetPosition[] => {
    const res: AssetPosition[] = []
    for (const [assetId, list] of byAsset) {
      const upto = list.filter((e) => ms(e.at) <= tMs)
      if (upto.length > 0) res.push(computePosition(assetId, upto))
    }
    return res
  }

  const point = (t: Date, value: string | null, priced: number, held: number): SeriesPoint => {
    const positions = positionsAt(t.getTime())
    let basis = new D(0), basisKnown = true, realized = new D(0), complete = true
    for (const p of positions) {
      realized = realized.plus(p.realizedKnown)
      if (!p.realizedComplete || p.unresolvedSales.length > 0) complete = false
      if (new D(p.quantity).gt(0)) {
        if (!p.basisComplete) { basisKnown = false; complete = false } else basis = basis.plus(p.knownRemainingBasis)
      }
    }
    return { t: t.toISOString(), costBasis: basisKnown ? out(basis) : null, realized: out(realized), value, priced, held, complete }
  }

  // Stored points inside the range, oldest first, one per instant; the live point replaces anything at/after "now".
  const includeLive = nearNow
  const stored = [...args.snapshots]
    .filter((s) => s.takenAt.getTime() >= fromMs && s.takenAt.getTime() <= toMs && (!includeLive || s.takenAt.getTime() < nowMs))
    .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())
  const seen = new Set<number>()
  const points: SeriesPoint[] = []
  for (const s of thin(stored, MAX_CHART_POINTS - (includeLive ? 1 : 0))) {
    const t = s.takenAt.getTime()
    if (seen.has(t)) continue
    seen.add(t)
    points.push(point(s.takenAt, snapshotValueIn(s.valuePkr, s.fxUsdtPkr, currency), s.pricedCount, s.heldCount))
  }
  if (includeLive) points.push(point(now, args.live.value, args.live.priced, args.live.held))

  // ── period statistics over the range ──
  const atBaseline = fromMs <= startedMs
  const inPeriod = (e: TradeEvent) => ms(e.at) > fromMs || (atBaseline && ms(e.at) === fromMs && !isOpeningRow(e.id))
  let moneyIn = new D(0), moneyOut = new D(0), openings = 0
  const flows: Array<{ at: number; amount: InstanceType<typeof D> }> = []
  for (const list of byAsset.values()) {
    for (const e of list.filter((x) => inPeriod(x) && ms(x.at) <= toMs)) {
      if (e.type === 'OPENING') { openings += 1; continue }
      const gross = new D(e.consideration ?? '0')
      const fee = new D(e.fee ?? '0')
      if (e.type === 'BUY') { const a = gross.plus(fee); moneyIn = moneyIn.plus(a); flows.push({ at: ms(e.at), amount: a }) }
      else { const a = gross.minus(fee); moneyOut = moneyOut.plus(a); flows.push({ at: ms(e.at), amount: a.neg() }) }
    }
  }
  let realizedInPeriod = new D(0)
  let realizedComplete = true
  for (const p of positionsAt(toMs)) {
    for (const r of p.realizedByEvent) {
      const t = ms(r.at)
      if ((t > fromMs || (atBaseline && t === fromMs)) && t <= toMs) {
        realizedInPeriod = realizedInPeriod.plus(r.realized)
        if (!r.complete) realizedComplete = false
      }
    }
  }

  // Start value: the opening MARKET value when the range starts at the baseline; otherwise a stored point taken close to the start.
  const nearest = (t: number): string | null => {
    let best: StoredPoint | null = null
    for (const s of args.snapshots) {
      const d = Math.abs(s.takenAt.getTime() - t)
      if (d <= SNAPSHOT_TOLERANCE_MS && (best === null || d < Math.abs(best.takenAt.getTime() - t))) best = s
    }
    return best ? snapshotValueIn(best.valuePkr, best.fxUsdtPkr, currency) : null
  }
  const valueStart = atBaseline ? args.openingMarketValue : nearest(fromMs)
  const valueEnd = includeLive ? args.live.value : nearest(toMs)

  let gain: string | null = null
  let reason: string | null = null
  let returnPct: string | null = null
  if (openings > 0) reason = 'Holdings were added by hand in this period, so their value when added is not known.'
  else if (valueStart === null || valueEnd === null) {
    reason = valueStart === null && atBaseline
      ? 'A valid price was missing for at least one token on the day tracking started, so the starting value is not known.'
      : 'A price is missing at the start or the end of this period.'
  } else {
    const g = new D(valueEnd).minus(valueStart).minus(moneyIn).plus(moneyOut)
    gain = out(g)
    const total = toMs - fromMs
    if (total > 0) {
      let denom = new D(valueStart)
      for (const f of flows) denom = denom.plus(f.amount.times(new D(toMs - f.at).div(total)))
      if (denom.gt(0)) returnPct = out(g.div(denom).times(100).toDecimalPlaces(2))
    }
  }

  return {
    currency,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    points,
    period: {
      realized: out(realizedInPeriod),
      realizedComplete,
      moneyIn: out(moneyIn),
      moneyOut: out(moneyOut),
      openingsAdded: openings,
      valueStart,
      valueEnd,
      gain,
      gainUnavailableReason: reason,
      returnPct,
      returnMethod: 'MODIFIED_DIETZ',
    },
    fxUnavailableAssets: [...unavailable].sort(),
    tracking: {
      version: args.version,
      startedAt: args.startedAt.toISOString(),
      timezone: args.timezone,
      startedToday: args.startedToday,
      observations: points.filter((p) => p.value !== null).length,
      openingMarketValue: args.openingMarketValue,
    },
  }
}

/** True when two instants fall on the same calendar day in `timezone`. */
export function sameDayInZone(a: Date, b: Date, timezone: string): boolean {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    return f.format(a) === f.format(b)
  } catch {
    return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
  }
}
