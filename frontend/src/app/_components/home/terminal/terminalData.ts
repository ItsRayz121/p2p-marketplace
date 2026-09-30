// Server-side data for the Terminal homepage. Same approach as getHomeData in
// app/page.tsx: talk to the backend origin directly, revalidate on the page's
// 60s ISR clock, cap every read with a deadline, and degrade each section to
// null (→ its empty state) instead of failing the render.
import { SERVER_API_ORIGIN } from '@/lib/serverApiOrigin'
import type {
  MarketsOverview, MarketActivity, MarketRatesSummary, MarketplaceAd,
  UsdtPriceHistory, RecentTrade, GasRecentPurchase,
} from '@/lib/api'

export interface TerminalStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  verifiedTraders: number
  todayTrades: number
}

export interface TerminalTopAds {
  buys: MarketplaceAd[]
  sells: MarketplaceAd[]
}

/** One line on the recent-trades tape — USDT, CTM and Gas feeds merged. */
export interface TapeItem {
  id: string
  kind: 'usdt' | 'ctm' | 'gas'
  who: string
  amount: number
  asset: string
  at: string
}

export interface TerminalData {
  overview: MarketsOverview | null
  summary: MarketRatesSummary | null
  stats: TerminalStats | null
  topAds: TerminalTopAds | null
  history24h: UsdtPriceHistory | null
  usdtActivity: MarketActivity | null
  tape: TapeItem[]
}

/** Merge the three recent-activity feeds into one time-ordered tape. */
export function buildTape(
  usdt: RecentTrade[] | null,
  ctm: RecentTrade[] | null,
  gas: GasRecentPurchase[] | null,
): TapeItem[] {
  const items: TapeItem[] = []
  for (const t of usdt ?? []) {
    items.push({ id: `usdt-${t.id}`, kind: 'usdt', who: t.buyerFullName || t.buyerUsername, amount: parseFloat(t.amount), asset: t.coin || 'USDT', at: t.completedAt })
  }
  for (const t of ctm ?? []) {
    items.push({ id: `ctm-${t.id}`, kind: 'ctm', who: t.buyerFullName || t.buyerUsername, amount: parseFloat(t.amount), asset: t.coin, at: t.completedAt })
  }
  for (const p of gas ?? []) {
    items.push({ id: `gas-${p.id}`, kind: 'gas', who: p.buyerFullName || p.buyerUsername || 'a trader', amount: parseFloat(p.amount), asset: p.token, at: p.completedAt })
  }
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return items.slice(0, 30)
}

export async function getTerminalData(): Promise<TerminalData> {
  const api = SERVER_API_ORIGIN
  const opts = { next: { revalidate: 60 }, signal: AbortSignal.timeout(8_000) }

  const results = await Promise.allSettled([
    fetch(`${api}/api/v1/markets/overview`, opts),
    fetch(`${api}/api/v1/marketplace/rates/summary`, opts),
    fetch(`${api}/api/v1/marketplace/stats`, opts),
    fetch(`${api}/api/v1/marketplace/top-ads`, opts),
    fetch(`${api}/api/v1/marketplace/rates/usdt-history?range=24h`, opts),
    fetch(`${api}/api/v1/markets/usdt/activity`, opts),
    fetch(`${api}/api/v1/marketplace/recent-trades`, opts),
    fetch(`${api}/api/v1/ctm/recent-trades`, opts),
    fetch(`${api}/api/v1/gas-fee/recent-purchases`, opts),
  ])

  async function json<T>(r: PromiseSettledResult<Response>): Promise<T | null> {
    if (r.status !== 'fulfilled' || !r.value.ok) return null
    try {
      const body = await r.value.json() as { success?: boolean; data?: T } | T
      if (body && typeof body === 'object' && 'data' in body && body.data !== undefined) {
        return (body as { data: T }).data
      }
      return body as T
    } catch { return null }
  }

  const [overview, summary, stats, topAds, history24h, usdtActivity, usdtTrades, ctmTrades, gasBuys] = await Promise.all([
    json<MarketsOverview>(results[0]),
    json<MarketRatesSummary>(results[1]),
    json<TerminalStats>(results[2]),
    json<TerminalTopAds>(results[3]),
    json<UsdtPriceHistory>(results[4]),
    json<MarketActivity>(results[5]),
    json<RecentTrade[]>(results[6]),
    json<RecentTrade[]>(results[7]),
    json<GasRecentPurchase[]>(results[8]),
  ])

  return {
    overview, summary, stats, topAds, history24h, usdtActivity,
    tape: buildTape(
      Array.isArray(usdtTrades) ? usdtTrades : null,
      Array.isArray(ctmTrades) ? ctmTrades : null,
      Array.isArray(gasBuys) ? gasBuys : null,
    ),
  }
}
