import { convertAmount, cleanRate, type Quote } from './currency'
import { summarizePortfolio, type TradeEvent, type Mark, type PortfolioSummary, type ValuedPosition } from './fifo'

/** Plain-data event row (no Prisma types) so the builder is pure and easy to test. */
export interface EventRow {
  id: string
  assetId: string
  type: 'BUY' | 'SELL' | 'OPENING'
  occurredAt: Date
  quantity: string
  consideration: string | null
  fee: string | null
  basis: string | null
  zeroCost: boolean
  quote: Quote
  /** PKR per 1 USDT at the time of this record, or null if none was recorded. */
  fxRate: string | null
}

export interface PriceRow {
  assetId: string
  price: string
  quote: Quote
  observedAt: Date
}

export interface PriceView {
  /** Price converted into the reporting currency at the CURRENT platform rate; null if it cannot be converted. */
  price: string | null
  original: string
  quote: Quote
  observedAt: string
}

export type SummaryPosition = Omit<ValuedPosition, 'realizedByEvent'>

export interface SummaryResult {
  currency: Quote
  method: 'FIFO'
  /** Current platform rate used for valuing marks; null when unavailable. */
  fx: { usdtPkr: string | null }
  summary: Omit<PortfolioSummary, 'positions'> & { positions: SummaryPosition[] }
  /** Tokens left out because a record has no usable exchange rate for the chosen currency. */
  fxUnavailableAssets: string[]
  prices: Record<string, PriceView>
  asOf: string
}

/**
 * Convert every record into `currency` at ITS OWN stored rate. A token with ANY unconvertible
 * record is excluded entirely (all of its records), and reported in `unavailable`.
 */
export function convertEvents(rows: EventRow[], currency: Quote): { events: TradeEvent[]; unavailable: Set<string> } {
  const unavailable = new Set<string>()
  const converted: TradeEvent[] = []

  rows.forEach((r, i) => {
    const conv = (v: string | null): string | null | undefined => {
      if (v === null) return undefined // field absent: keep absent
      return convertAmount(v, r.quote, currency, r.fxRate)
    }
    const consideration = conv(r.consideration)
    const fee = conv(r.fee)
    const basis = conv(r.basis)
    if (consideration === null || fee === null || basis === null) {
      unavailable.add(r.assetId)
      return
    }
    const e: TradeEvent = {
      id: r.id,
      assetId: r.assetId,
      type: r.type,
      at: r.occurredAt.toISOString(),
      seq: i,
      quantity: r.quantity,
    }
    if (consideration !== undefined) e.consideration = consideration
    if (fee !== undefined) e.fee = fee
    if (r.type === 'OPENING') {
      e.basis = basis === undefined ? null : basis
      e.zeroCost = r.zeroCost
    }
    converted.push(e)
  })

  return { events: converted.filter((e) => !unavailable.has(e.assetId)), unavailable }
}
/**
 * Build the summary in `currency`.
 *
 * - Every record is converted at ITS OWN stored rate, so an old PKR trade shown in USDT uses the
 *   rate recorded for that trade, never today's.
 * - If any record of a token cannot be converted (no rate), the WHOLE token is left out of the
 *   engine and listed in `fxUnavailableAssets`; it is never valued at zero or at another rate.
 * - Marks ("current prices") are valued now, so they use the current platform rate.
 */
export function buildSummary(args: {
  events: EventRow[]
  prices: PriceRow[]
  currency: Quote
  platformRate: string | null
  now?: Date
}): SummaryResult {
  const { currency } = args
  const platformRate = cleanRate(args.platformRate)

  const { events: usable, unavailable } = convertEvents(args.events, currency)

  const marks: Record<string, Mark> = {}
  const prices: Record<string, PriceView> = {}
  for (const p of args.prices) {
    const price = convertAmount(p.price, p.quote, currency, platformRate)
    prices[p.assetId] = { price, original: p.price, quote: p.quote, observedAt: p.observedAt.toISOString() }
    marks[p.assetId] = { price }
  }

  const engine = summarizePortfolio(usable, marks)
  const fxUnavailableAssets = [...unavailable].sort()

  return {
    currency,
    method: 'FIFO',
    fx: { usdtPkr: platformRate },
    summary: {
      ...engine,
      // Per-sale detail is for period reports only; it is not part of the summary.
      positions: engine.positions.map((p) => {
        const { realizedByEvent, ...rest } = p
        void realizedByEvent
        return rest
      }),
      partial: engine.partial || fxUnavailableAssets.length > 0,
    },
    fxUnavailableAssets,
    prices,
    asOf: (args.now ?? new Date()).toISOString(),
  }
}
