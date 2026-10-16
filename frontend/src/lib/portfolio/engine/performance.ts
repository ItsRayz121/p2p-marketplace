import { D } from './decimal'
import { computePosition, type AssetPosition, type TradeEvent } from './fifo'
import { convertAmount, type Quote } from './currency'
import { convertEvents, type EventRow, type PriceRow } from './summaryBuilder'

/** One sampled moment. `null` means unknown at that moment (a gap), never zero. */
export interface SeriesPoint {
  t: string
  /** Remaining cost of what was held; null if any held unit had unknown cost. */
  costBasis: string | null
  /** Cumulative realized profit/loss up to t (known parts). */
  realized: string
  /** Marked value of what was held; null unless EVERY held token had a price at t. */
  value: string | null
  priced: number
  held: number
  /** False when unknown cost or an oversold history makes cost/realized incomplete at t. */
  complete: boolean
}

export interface PeriodStats {
  /** Realized profit/loss from sales inside the period (from, to]. */
  realized: string
  realizedComplete: boolean
  /** Buys in the period: consideration + fees. */
  moneyIn: string
  /** Sells in the period: consideration - fees. */
  moneyOut: string
  openingsAdded: number
  valueStart: string | null
  valueEnd: string | null
  /** valueEnd - valueStart - moneyIn + moneyOut, only when it is meaningful. */
  gain: string | null
  gainUnavailableReason: string | null
  /** Percentage on a Modified Dietz basis (flows weighted by time), only when a valid denominator exists. */
  returnPct: string | null
  returnMethod: 'MODIFIED_DIETZ'
}

export interface PerformanceResult {
  currency: Quote
  from: string
  to: string
  points: SeriesPoint[]
  period: PeriodStats
  fxUnavailableAssets: string[]
}

export const MAX_POINTS = 60

const out = (d: InstanceType<typeof D>) => d.toFixed()
const ms = (iso: string) => Date.parse(iso)

/**
 * Sample the portfolio over [from, to].
 *
 * History is built ONLY from what is genuinely known:
 * - holdings and cost come from the recorded entries up to each moment;
 * - a value appears only where every held token has a price entered at or before that moment, in the
 *   reporting currency (no interpolation, no backfilling, no converting an old price at today's rate);
 * - the final point, if it is "now", is valued with the current marks the summary uses.
 */
export function computePerformance(args: {
  events: EventRow[]
  prices: PriceRow[]
  currency: Quote
  /** Current marks in the reporting currency (already converted at today's platform rate), by asset; null = none. */
  currentMarks: Record<string, string | null>
  from: Date
  to: Date
  now?: Date
  maxPoints?: number
}): PerformanceResult {
  const { currency } = args
  const nowMs = (args.now ?? new Date()).getTime()
  const fromMs = args.from.getTime()
  const toMs = args.to.getTime()
  if (!(fromMs <= toMs)) throw new Error('invalid range')

  const { events, unavailable } = convertEvents(args.events, currency)

  const byAsset = new Map<string, TradeEvent[]>()
  for (const e of events) {
    const list = byAsset.get(e.assetId) ?? []
    list.push(e)
    byAsset.set(e.assetId, list)
  }

  // Same-currency observations only: an old price in the other currency would need the rate of that day.
  const obsByAsset = new Map<string, Array<{ at: number; price: string }>>()
  for (const p of args.prices) {
    if (p.quote !== currency) continue
    const list = obsByAsset.get(p.assetId) ?? []
    list.push({ at: p.observedAt.getTime(), price: p.price })
    obsByAsset.set(p.assetId, list)
  }
  for (const list of obsByAsset.values()) list.sort((a, b) => a.at - b.at)

  const positionsAt = (tMs: number): AssetPosition[] => {
    const res: AssetPosition[] = []
    for (const [assetId, list] of byAsset) {
      const upto = list.filter((e) => ms(e.at) <= tMs)
      if (upto.length > 0) res.push(computePosition(assetId, upto))
    }
    return res
  }

  const priceAt = (assetId: string, tMs: number): string | null => {
    if (tMs >= nowMs) return args.currentMarks[assetId] ?? null
    const list = obsByAsset.get(assetId)
    if (!list) return null
    let found: string | null = null
    for (const o of list) {
      if (o.at <= tMs) found = o.price
      else break
    }
    return found
  }

  const valueOf = (positions: AssetPosition[], tMs: number): { value: string | null; priced: number; held: number } => {
    const heldPos = positions.filter((p) => new D(p.quantity).gt(0))
    let total = new D(0)
    let priced = 0
    for (const p of heldPos) {
      const price = priceAt(p.assetId, tMs)
      if (price === null) continue
      priced += 1
      total = total.plus(new D(price).times(p.quantity))
    }
    const complete = priced === heldPos.length
    return { value: complete ? out(total) : null, priced, held: heldPos.length }
  }

  const pointAt = (tMs: number): SeriesPoint => {
    const positions = positionsAt(tMs)
    const heldPos = positions.filter((p) => new D(p.quantity).gt(0))
    let basis = new D(0)
    let basisKnown = true
    let realized = new D(0)
    let complete = true
    for (const p of positions) {
      realized = realized.plus(p.realizedKnown)
      if (!p.realizedComplete || p.unresolvedSales.length > 0) complete = false
    }
    for (const p of heldPos) {
      if (!p.basisComplete) { basisKnown = false; complete = false } else basis = basis.plus(p.knownRemainingBasis)
    }
    const v = valueOf(positions, tMs)
    return {
      t: new Date(tMs).toISOString(),
      costBasis: basisKnown ? out(basis) : null,
      realized: out(realized),
      value: v.value,
      priced: v.priced,
      held: v.held,
      complete,
    }
  }

  // ── sampled points ──
  const n = Math.max(1, Math.min(args.maxPoints ?? MAX_POINTS, MAX_POINTS))
  const times: number[] = []
  if (fromMs === toMs || n === 1) times.push(toMs)
  else for (let i = 0; i < n; i++) times.push(Math.round(fromMs + ((toMs - fromMs) * i) / (n - 1)))
  const points = times.map(pointAt)

  // ── period statistics over (from, to] ──
  const inPeriod = (e: TradeEvent) => ms(e.at) > fromMs && ms(e.at) <= toMs
  let moneyIn = new D(0)
  let moneyOut = new D(0)
  let openings = 0
  const flows: Array<{ at: number; amount: InstanceType<typeof D> }> = []
  for (const list of byAsset.values()) {
    for (const e of list.filter(inPeriod)) {
      if (e.type === 'OPENING') { openings += 1; continue }
      const gross = new D(e.consideration ?? '0')
      const fee = new D(e.fee ?? '0')
      if (e.type === 'BUY') {
        const a = gross.plus(fee)
        moneyIn = moneyIn.plus(a)
        flows.push({ at: ms(e.at), amount: a })
      } else {
        const a = gross.minus(fee)
        moneyOut = moneyOut.plus(a)
        flows.push({ at: ms(e.at), amount: a.neg() })
      }
    }
  }

  let realizedInPeriod = new D(0)
  let realizedComplete = true
  for (const p of positionsAt(toMs)) {
    for (const r of p.realizedByEvent) {
      const t = ms(r.at)
      if (t > fromMs && t <= toMs) {
        realizedInPeriod = realizedInPeriod.plus(r.realized)
        if (!r.complete) realizedComplete = false
      }
    }
  }

  const startV = valueOf(positionsAt(fromMs), fromMs).value
  const endV = valueOf(positionsAt(toMs), toMs).value

  let gain: string | null = null
  let reason: string | null = null
  let returnPct: string | null = null
  if (openings > 0) reason = 'Opening holdings were added in this period, so their value at that time is unknown.'
  else if (startV === null || endV === null) reason = 'A price is missing at the start or the end of this period.'
  else {
    const g = new D(endV).minus(startV).minus(moneyIn).plus(moneyOut)
    gain = out(g)
    const total = toMs - fromMs
    if (total > 0) {
      let denom = new D(startV)
      for (const f of flows) denom = denom.plus(f.amount.times(new D(toMs - f.at).div(total)))
      if (denom.gt(0)) returnPct = out(g.div(denom).times(100).toDecimalPlaces(2))
    }
  }

  return {
    currency,
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    points,
    period: {
      realized: out(realizedInPeriod),
      realizedComplete,
      moneyIn: out(moneyIn),
      moneyOut: out(moneyOut),
      openingsAdded: openings,
      valueStart: startV,
      valueEnd: endV,
      gain,
      gainUnavailableReason: reason,
      returnPct,
      returnMethod: 'MODIFIED_DIETZ',
    },
    fxUnavailableAssets: [...unavailable].sort(),
  }
}

/** Convert the latest mark of each asset into `currency` at the current platform rate (null if impossible). */
export function currentMarksIn(prices: PriceRow[], currency: Quote, platformRate: string | null): Record<string, string | null> {
  const marks: Record<string, string | null> = {}
  for (const p of prices) marks[p.assetId] = convertAmount(p.price, p.quote, currency, platformRate)
  return marks
}
