// Pure rules for showing GLOBAL (CoinGecko) market data on /markets rows. Kept free of React and
// imports so they can be unit tested with `node --test`. Local RupChain data always wins.

interface RowLike { kind: string; dataSource: string; changePercent24h: number | null }
interface RefLike {
  status: string
  change24hPct?: number | null
  stale?: boolean
}

/** Only assets the platform explicitly prices from the live market (gas-fee assets) are external.
 *  Having no local trades or an empty chart does NOT make a row external. */
export function isExternalRow(row: Pick<RowLike, 'kind' | 'dataSource'>): boolean {
  return row.kind === 'gas' && row.dataSource === 'live_market'
}

/**
 * The global 24h % for a row, or null when none should be shown. Local data is never replaced:
 * a row that has its own 24h change keeps it. A missing global value stays null (never 0).
 */
export function globalChange24h(row: RowLike, ref: RefLike | null | undefined): number | null {
  if (!isExternalRow(row)) return null
  if (row.changePercent24h !== null && row.changePercent24h !== undefined) return null
  if (!ref || ref.status !== 'ok') return null
  const v = ref.change24hPct
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function globalChartLabel(ref: { stale?: boolean; provider: string; providerId?: string; lastUpdated?: string }): string {
  const when = ref.lastUpdated && Number.isFinite(Date.parse(ref.lastUpdated)) ? ` Provider updated ${new Date(ref.lastUpdated).toUTCString()}.` : ''
  return `Global 7-day price history from ${ref.provider}, USD quote. Not RupChain trade data.${ref.stale ? ' Delayed: the latest refresh failed.' : ''}${when}`
}

export function globalChangeLabel(ref: { provider: string }): string {
  return `Global 24-hour price change from ${ref.provider} in USD. Not RupChain trade data.`
}
