// Shared OHLC / line price-history bucketing. Used by both the CTM token chart
// and the USDT-marketplace chart so the two can never drift. Callers fetch the
// relevant completed trades (ascending by time) and hand them here; the price
// unit is whatever the caller passes (CTM = PKR per token, USDT = PKR per USDT).

export type PriceRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all'

export interface PriceCandle { t: string; o: number; h: number; l: number; c: number; n: number }
export interface PricePoint { t: string; p: number }

export interface PriceHistoryResult {
  range: PriceRange
  candles: PriceCandle[]
  points: PricePoint[]
  tradeCount: number
  bucketMs: number
  from: string
  to: string
  /** Hint: enough distinct buckets to render a candlestick view sensibly. */
  hasCandles: boolean
}

export const PRICE_RANGES: PriceRange[] = ['24h', '7d', '30d', '90d', '1y', 'all']

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const RANGE_MS: Record<PriceRange, number | null> = {
  '24h': 24 * HOUR,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '1y': 365 * DAY,
  'all': null,
}

function bucketMsFor(range: PriceRange, spanMs: number): number {
  switch (range) {
    case '24h': return HOUR        // 24 buckets
    case '7d': return 6 * HOUR     // 28 buckets
    case '30d': return DAY         // 30 buckets
    case '90d': return DAY         // 90 buckets
    case '1y': return 7 * DAY      // ~52 buckets
    case 'all': {
      // Aim for ~60 buckets across the actual span, clamped to sane sizes.
      const target = Math.max(spanMs / 60, HOUR)
      return Math.min(Math.max(target, HOUR), 30 * DAY)
    }
  }
}

/** Resolve the window start for a range. For "all", anchor on the earliest trade. */
export function priceRangeStart(range: PriceRange, now: Date, earliest: Date | null): Date {
  if (range === 'all') return earliest ?? new Date(now.getTime() - 30 * DAY)
  return new Date(now.getTime() - (RANGE_MS[range] as number))
}

/**
 * Bucket ascending {price, at} trades into OHLC candles + a per-bucket close
 * line. `trades` must already be filtered to the window and sorted ascending.
 */
export function buildPriceHistory(
  trades: { price: number; at: Date }[],
  range: PriceRange,
  from: Date,
  now: Date,
): PriceHistoryResult {
  const to = now
  const spanMs = Math.max(to.getTime() - from.getTime(), HOUR)
  const bucketMs = bucketMsFor(range, spanMs)
  const fromAligned = Math.floor(from.getTime() / bucketMs) * bucketMs

  const byBucket = new Map<number, PriceCandle>()
  for (const tr of trades) {
    const at = tr.at.getTime()
    const price = tr.price
    if (!(price > 0)) continue
    const key = Math.floor((at - fromAligned) / bucketMs)
    const bucketStart = new Date(fromAligned + key * bucketMs).toISOString()
    const existing = byBucket.get(key)
    if (!existing) {
      byBucket.set(key, { t: bucketStart, o: price, h: price, l: price, c: price, n: 1 })
    } else {
      existing.h = Math.max(existing.h, price)
      existing.l = Math.min(existing.l, price)
      existing.c = price // ascending → latest wins
      existing.n += 1
    }
  }

  const candles = [...byBucket.values()].sort((a, b) => a.t.localeCompare(b.t))
  const points: PricePoint[] = candles.map((c) => ({ t: c.t, p: c.c }))

  return {
    range,
    candles,
    points,
    tradeCount: trades.length,
    bucketMs,
    from: from.toISOString(),
    to: to.toISOString(),
    hasCandles: candles.length >= 4,
  }
}
