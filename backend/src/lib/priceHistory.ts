// Shared OHLC / line price-history bucketing. Used by both the CTM token chart
// and the USDT-marketplace chart so the two can never drift. Callers fetch the
// relevant completed trades (ascending by time) and hand them here; the price
// unit is whatever the caller passes (CTM = PKR per token, USDT = PKR per USDT).

export type PriceRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all'

export interface PriceCandle {
  t: string; o: number; h: number; l: number; c: number; n: number
  /** true when the bucket had no trade and the close was carried forward. */
  filled?: boolean
}
export interface PricePoint { t: string; p: number; filled?: boolean }

export interface PriceHistoryResult {
  range: PriceRange
  candles: PriceCandle[]
  points: PricePoint[]
  tradeCount: number
  /** Trades discarded as price outliers before bucketing (bad records). */
  droppedOutliers: number
  bucketMs: number
  from: string
  to: string
  /** Hint: enough real (traded) buckets to render a candlestick view sensibly. */
  hasCandles: boolean
}

export const PRICE_RANGES: PriceRange[] = ['24h', '7d', '30d', '90d', '1y', 'all']

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// A single fat-finger trade record must never define the axis. Anything priced
// outside median/OUTLIER_FACTOR … median*OUTLIER_FACTOR is dropped before
// bucketing. 3x is wide enough to keep every plausible real move.
const OUTLIER_FACTOR = 3

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

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  if (s.length % 2) return s[m] as number
  return ((s[m - 1] as number) + (s[m] as number)) / 2
}

/**
 * Bucket ascending {price, at} trades into OHLC candles + a per-bucket close
 * line. `trades` must already be filtered to the window and sorted ascending.
 *
 * Two things keep the series legible on a low-volume market:
 *  - price outliers (bad records) are dropped up front, so the axis fits reality;
 *  - every bucket from the first trade to `now` is emitted — a quiet bucket
 *    carries the previous close forward as a flat doji (`n: 0`, `filled: true`),
 *    so "30d" always shows ~30 daily steps instead of 2-3 smeared candles.
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
  const lastKey = Math.floor((to.getTime() - fromAligned) / bucketMs)

  // ── drop price outliers (median-relative) ──────────────────────────────────
  const inWindow = trades.filter((tr) => tr.price > 0)
  const med = median(inWindow.map((tr) => tr.price))
  const clean = med > 0
    ? inWindow.filter((tr) => tr.price >= med / OUTLIER_FACTOR && tr.price <= med * OUTLIER_FACTOR)
    : inWindow
  const droppedOutliers = inWindow.length - clean.length

  // ── real (traded) buckets ─────────────────────────────────────────────────
  const byBucket = new Map<number, PriceCandle>()
  for (const tr of clean) {
    const key = Math.floor((tr.at.getTime() - fromAligned) / bucketMs)
    if (key < 0 || key > lastKey) continue
    const existing = byBucket.get(key)
    if (!existing) {
      byBucket.set(key, {
        t: new Date(fromAligned + key * bucketMs).toISOString(),
        o: tr.price, h: tr.price, l: tr.price, c: tr.price, n: 1,
      })
    } else {
      existing.h = Math.max(existing.h, tr.price)
      existing.l = Math.min(existing.l, tr.price)
      existing.c = tr.price // ascending → latest wins
      existing.n += 1
    }
  }

  const base = {
    range, tradeCount: clean.length, droppedOutliers, bucketMs,
    from: from.toISOString(), to: to.toISOString(),
  }
  if (byBucket.size === 0) {
    return { ...base, candles: [], points: [], hasCandles: false }
  }

  // ── gap-fill from the first traded bucket through to now ───────────────────
  const firstKey = Math.min(...byBucket.keys())
  const candles: PriceCandle[] = []
  let prevClose = 0
  for (let key = firstKey; key <= lastKey; key++) {
    const hit = byBucket.get(key)
    if (hit) {
      candles.push(hit)
      prevClose = hit.c
    } else {
      const t = new Date(fromAligned + key * bucketMs).toISOString()
      candles.push({ t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, n: 0, filled: true })
    }
  }

  const points: PricePoint[] = candles.map((c) => (
    c.filled ? { t: c.t, p: c.c, filled: true } : { t: c.t, p: c.c }
  ))
  const realBuckets = candles.reduce((acc, c) => acc + (c.n > 0 ? 1 : 0), 0)

  return {
    ...base,
    candles,
    points,
    hasCandles: realBuckets >= 3 && candles.length >= 4,
  }
}
