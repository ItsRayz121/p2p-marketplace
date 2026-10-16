/** How old a current price is, and where it came from. Pure, so it is easy to test. */

/** A price older than this is flagged as possibly out of date. */
export const STALE_AFTER_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export interface PriceAge {
  /** Whole days since the price was recorded (0 = today). */
  days: number
  stale: boolean
  /** Short text such as "today" or "12 days ago". */
  label: string
}

export function priceAge(observedAt: string, now: Date = new Date()): PriceAge | null {
  const t = Date.parse(observedAt)
  if (Number.isNaN(t)) return null
  const days = Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
  const label = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
  return { days, stale: days >= STALE_AFTER_DAYS, label }
}

/** Values the API stores in `source` for a typed-in price, plus 'platform' for a proven RupChain trade. */
export const PRICE_SOURCE_LABEL: Record<string, string> = {
  platform: 'Latest RupChain trade',
  manual: 'Price you entered',
  p2p: 'Price you entered (P2P)',
  exchange: 'Price you entered (exchange)',
  other: 'Price you entered (other source)',
}

export function priceSourceLabel(source: string | undefined): string {
  return PRICE_SOURCE_LABEL[source ?? 'manual'] ?? PRICE_SOURCE_LABEL.manual!
}

export type PriceSourceChoice = 'manual' | 'p2p' | 'exchange' | 'other'
export const PRICE_SOURCE_CHOICES: Array<{ value: PriceSourceChoice; label: string }> = [
  { value: 'manual', label: 'Not stated' },
  { value: 'p2p', label: 'P2P deal' },
  { value: 'exchange', label: 'Another exchange' },
  { value: 'other', label: 'Other' },
]
