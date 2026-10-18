import { D } from './decimal'
import { convertAmount, cleanRate, type Quote } from './currency'

/**
 * Valuing the holdings at one moment, the same way for the summary, the stored snapshots and the opening
 * baseline, so the chart's latest point and the headline can never disagree.
 *
 * Unknown stays unknown: if any held token has no usable quote (or its quote cannot be converted), the total
 * is null (a gap) instead of a partial sum or a zero.
 */

/** A quote older than this many days is flagged as possibly out of date (it is still used, with its date). */
export const STALE_AFTER_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export interface HeldInput { assetId: string; quantity: string }
export interface MarkInput { price: string; quote: Quote; observedAt: Date }

export interface Valuation {
  /** Total in PKR, or null when not every held token had a usable quote. A genuine empty portfolio is '0'. */
  valuePkr: string | null
  heldCount: number
  pricedCount: number
  staleCount: number
}

export function valueHoldings(held: HeldInput[], marks: ReadonlyMap<string, MarkInput>, platformRate: string | null | undefined, now: Date): Valuation {
  const rate = cleanRate(platformRate)
  let total = new D(0)
  let priced = 0
  let stale = 0
  const positive = held.filter((h) => new D(h.quantity).gt(0))
  for (const h of positive) {
    const m = marks.get(h.assetId)
    if (!m) continue
    const price = convertAmount(m.price, m.quote, 'PKR', rate)
    if (price === null) continue
    priced += 1
    total = total.plus(new D(price).times(h.quantity))
    if (now.getTime() - m.observedAt.getTime() >= STALE_AFTER_DAYS * DAY_MS) stale += 1
  }
  return {
    valuePkr: priced === positive.length ? total.toFixed() : null,
    heldCount: positive.length,
    pricedCount: priced,
    staleCount: stale,
  }
}

/** A stored PKR value shown in `currency` at the rate of the same moment; null when it cannot be converted. */
export function snapshotValueIn(valuePkr: string | null, fxUsdtPkr: string | null, currency: Quote): string | null {
  if (valuePkr === null) return null
  return convertAmount(valuePkr, 'PKR', currency, fxUsdtPkr)
}

/** Start of the minute: one stored point per minute at most, so a retry or a burst of events cannot duplicate a point. */
export function minuteBucket(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000)
}
