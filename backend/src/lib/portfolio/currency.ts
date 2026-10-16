import { D, ALLOC_DP, ROUND } from './decimal'

export type Quote = 'PKR' | 'USDT'
export const QUOTES: readonly Quote[] = ['PKR', 'USDT']

/** Plain positive decimal string (no exponent). Rates are PKR per 1 USDT. */
const RATE_RE = /^\d{1,10}(\.\d{1,18})?$/
const AMOUNT_MAX_INT_DIGITS = 28

/** A usable USDT/PKR rate, or null. A zero, negative, malformed or absent rate is "unavailable". */
export function cleanRate(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!RATE_RE.test(s)) return null
  return new D(s).gt(0) ? new D(s).toFixed() : null
}

/**
 * Convert `amount` from one quote currency to another using a PKR-per-USDT `rate`.
 * - Same currency: returned unchanged, no rate needed (exact).
 * - Otherwise a missing/invalid rate yields null ("unavailable"): the caller must exclude the figure
 *   and say so; it must NEVER substitute a different rate or treat the result as zero.
 * Results are rounded half-even to ALLOC_DP places; a result too large to store yields null.
 */
export function convertAmount(amount: string, from: Quote, to: Quote, rate: string | null | undefined): string | null {
  if (from === to) return amount
  const r = cleanRate(rate)
  if (r === null) return null
  const a = new D(amount)
  const out = from === 'USDT' ? a.times(r) : a.div(r)
  const rounded = out.toDecimalPlaces(ALLOC_DP, ROUND)
  const text = rounded.toFixed()
  const intDigits = text.replace(/^-/, '').split('.')[0]!.length
  return intDigits > AMOUNT_MAX_INT_DIGITS ? null : text
}

export interface FxStamp {
  fxRate: string | null
  fxSource: 'platform' | 'manual' | null
}

/** A record dated this recently is treated as entered "now", so the current platform rate is valid for it. */
export const PLATFORM_RATE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Decide which rate to store with a new record.
 * 1. A rate the user typed always wins (provenance 'manual').
 * 2. Otherwise the platform rate is stamped ONLY when the record is dated within the last day.
 *    Stamping today's rate onto an old trade would silently rebuild history at the wrong rate.
 * 3. Otherwise no rate is stored; converting this record to the other currency is "unavailable".
 */
export function chooseFxStamp(opts: {
  userRate: string | null | undefined
  platformRate: string | null | undefined
  occurredAtMs: number
  nowMs: number
}): FxStamp {
  const manual = cleanRate(opts.userRate)
  if (manual !== null) return { fxRate: manual, fxSource: 'manual' }
  const platform = cleanRate(opts.platformRate)
  const age = opts.nowMs - opts.occurredAtMs
  if (platform !== null && age <= PLATFORM_RATE_WINDOW_MS) return { fxRate: platform, fxSource: 'platform' }
  return { fxRate: null, fxSource: null }
}
