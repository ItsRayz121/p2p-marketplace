/**
 * Pure rules for the global reference prices (CoinGecko). No DB, no network, no env, so every
 * decision that can put the wrong number next to a token is unit tested.
 */

/** Provider ids that CoinGecko has frozen/migrated; the value is the live successor.
 *  Verified against /coins/markets on 2026-10-10: `matic-network` ("MATIC (migrated to POL)") last
 *  updated 2026-02-03 with no 24h change, while `polygon-ecosystem-token` ("POL (ex-MATIC)") is live. */
export const SUPERSEDED_IDS: Record<string, string> = { 'matic-network': 'polygon-ecosystem-token' }

/** Tickers that legitimately name the same asset. */
// TON: CoinGecko now lists `the-open-network` as "Gram (prev. Toncoin)" (verified 2026-10-10).
const SYMBOL_EQUIVALENTS: Record<string, string[]> = { MATIC: ['MATIC', 'POL'], POL: ['POL', 'MATIC'], TON: ['TON', 'GRAM'], GRAM: ['GRAM', 'TON'] }

/** A provider row older than this is a dead/frozen listing, not a live market. */
export const MAX_PROVIDER_AGE_MS = 24 * 3600 * 1000
/** The 24h % is only shown while the data it came from is at most this old. */
export const CHANGE_MAX_AGE_MS = 6 * 3600 * 1000

export const applySuperseded = (id: string): string => SUPERSEDED_IDS[id] ?? id

export function symbolMatches(slugSymbol: string, providerSymbol: string | null | undefined): boolean {
  if (!providerSymbol) return false
  const want = slugSymbol.toUpperCase()
  const ok = SYMBOL_EQUIVALENTS[want] ?? [want]
  return ok.includes(providerSymbol.toUpperCase())
}

export type GasPick = { id: string } | { reason: 'no_provider_id' | 'ambiguous' }

/**
 * Choose the provider id for a gas-fee asset from what the admin configured. Never guesses:
 * conflicting configured ids resolve only if one of them is the known native id, otherwise the
 * asset is left unmapped. Non-native tokens without an explicit id are never mapped by ticker.
 */
export function pickGasProviderId(
  tokens: Array<{ coingeckoId: string | null; tokenType: string; chainCoingeckoId: string | null }>,
  nativeId: string | undefined,
): GasPick {
  const candidates = new Set<string>()
  for (const t of tokens) {
    const id = t.coingeckoId ?? (t.tokenType === 'native' ? t.chainCoingeckoId : null)
    if (id) candidates.add(applySuperseded(id))
  }
  const native = nativeId ? applySuperseded(nativeId) : undefined
  if (candidates.size === 1) return { id: [...candidates][0]! }
  if (candidates.size === 0) return tokens.some((t) => t.tokenType === 'native') && native ? { id: native } : { reason: 'no_provider_id' }
  if (native && candidates.has(native)) return { id: native }
  return { reason: 'ambiguous' }
}

export interface CgMarketRow {
  id: string
  symbol?: string | null
  current_price: number | null
  last_updated: string | null
  price_change_percentage_24h_in_currency?: number | null
  price_change_percentage_24h?: number | null
  price_change_percentage_7d_in_currency?: number | null
  sparkline_in_7d?: { price: number[] }
}

export interface ReferenceData {
  providerId: string
  providerSymbol: string | null
  price: number
  /** Global % change over the last 24 hours (USD). null = the provider did not report it (NOT zero). */
  change24hPct: number | null
  /** % change over the last 7 days — the same period the chart shows. */
  change7dPct: number | null
  points: number[]
  /** When the provider says the price was last updated. */
  lastUpdated: string
  /** When RupChain last fetched it from the provider. */
  fetchedAt: string
}

const round2 = (n: number) => Math.round(n * 100) / 100
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function downsample(points: number[], max: number): number[] {
  if (points.length <= max) return points
  const out: number[] = []
  const step = (points.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!)
  return out
}

/** Provider's 24h % (`_in_currency` first, plain field as fallback). Missing stays null. */
export function pick24h(r: CgMarketRow): number | null {
  const v = finite(r.price_change_percentage_24h_in_currency) ? r.price_change_percentage_24h_in_currency
    : finite(r.price_change_percentage_24h) ? r.price_change_percentage_24h : null
  return v === null ? null : round2(v)
}

/** Normalise one provider row, or null when it cannot honestly be shown (no price, no real series, or a frozen listing). */
export function toReferenceData(r: CgMarketRow, fetchedAt: string, now: number, maxPoints: number): ReferenceData | null {
  const points = (r.sparkline_in_7d?.price ?? []).filter(finite)
  if (!finite(r.current_price) || points.length < 2) return null
  const updated = r.last_updated ? Date.parse(r.last_updated) : NaN
  if (Number.isFinite(updated) && now - updated > MAX_PROVIDER_AGE_MS) return null // frozen/migrated listing
  return {
    providerId: r.id,
    providerSymbol: r.symbol ?? null,
    price: r.current_price,
    change24hPct: pick24h(r),
    change7dPct: finite(r.price_change_percentage_7d_in_currency) ? round2(r.price_change_percentage_7d_in_currency) : null,
    points: downsample(points, maxPoints),
    lastUpdated: r.last_updated ?? fetchedAt,
    fetchedAt,
  }
}

/** The 24h % to show: only while the fetch it came from is recent enough. */
export function changeIfFresh(d: { change24hPct: number | null; fetchedAt: string }, now: number): number | null {
  const age = now - Date.parse(d.fetchedAt)
  return Number.isFinite(age) && age <= CHANGE_MAX_AGE_MS ? d.change24hPct : null
}
