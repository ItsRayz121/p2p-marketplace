import { db } from '../lib/prisma'
import { D, ALLOC_DP, ROUND } from '../lib/portfolio/decimal'
import type { Quote } from '../lib/portfolio/currency'
import { classifyTrade } from '../lib/portfolio/ctmImport'
import { forcedReleaseRefs, factsFromTrade, TRADE_FACTS_SELECT } from './ctmTradeFacts.service'

/**
 * Read-only helpers that let a tracked token that mirrors a RupChain token use the platform's own data:
 * the price of the latest proven trade of that token, and the token's logo. Nothing here writes anything.
 */

export interface MarkRow {
  assetId: string
  price: string
  quote: Quote
  observedAt: Date
  /** Where the price came from: 'platform' (a proven RupChain trade) or the way the user entered it ('manual', 'p2p', ...). */
  source?: string
}

/** How many of a token's most recent settled trades are examined to find one that is proven. */
export const PRICE_LOOKBACK_TRADES = 100
const MAX_ROWS = 2000
const CACHE_TTL_MS = 60_000

interface CachedMark { at: number; mark: { price: string; observedAt: Date } | null }
const cache = new Map<string, CachedMark>()
/** Test hook. */
export function resetPlatformMarkCache(): void { cache.clear() }

/**
 * Latest platform trade price (PKR per token) for each linked tracker token.
 *
 * A price comes only from a trade the portfolio import would also accept as settled: not disputed,
 * not auto-completed by the timer, not force-completed by an administrator, and, for on-chain
 * settlement, with a verified token transfer. A status of "completed" alone does not prove that
 * money and tokens both moved, and one unproven trade must not set what everyone's holdings are
 * worth. When none of a token's recent trades is proven, the token has no platform price.
 */
export async function platformMarksFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<MarkRow[]> {
  const byToken = new Map<string, string[]>()
  for (const l of links) {
    if (l.ctmTokenId) byToken.set(l.ctmTokenId, [...(byToken.get(l.ctmTokenId) ?? []), l.id])
  }
  if (byToken.size === 0) return []

  const now = Date.now()
  const found = new Map<string, CachedMark['mark']>()
  const missing: string[] = []
  for (const tokenId of byToken.keys()) {
    const c = cache.get(tokenId)
    if (c && now - c.at < CACHE_TTL_MS) found.set(tokenId, c.mark)
    else missing.push(tokenId)
  }

  if (missing.length > 0) {
    const trades = await db.ctmTrade.findMany({
      where: { tokenId: { in: missing }, status: 'completed', completedAt: { not: null } },
      orderBy: { completedAt: 'desc' },
      take: Math.min(MAX_ROWS, PRICE_LOOKBACK_TRADES * missing.length),
      select: TRADE_FACTS_SELECT,
    })
    const forced = await forcedReleaseRefs(trades.map((t) => t.tradeRef))
    const result = new Map<string, CachedMark['mark']>(missing.map((id) => [id, null]))
    for (const t of trades) {
      if (result.get(t.tokenId)) continue // newest proven trade already chosen
      // The buyer's view is used only to ask "did this trade settle?"; the price is the same for both sides.
      if (classifyTrade(factsFromTrade(t, t.buyerId, forced)).kind !== 'eligible') continue
      const qty = new D(t.tokenAmount.toFixed())
      const fiat = new D(t.fiatAmount.toFixed())
      if (!qty.gt(0) || !fiat.gt(0) || !t.completedAt) continue
      const price = fiat.div(qty).toDecimalPlaces(ALLOC_DP, ROUND)
      if (!price.gt(0)) continue
      result.set(t.tokenId, { price: price.toFixed(), observedAt: t.completedAt })
    }
    for (const [tokenId, mark] of result) {
      cache.set(tokenId, { at: now, mark })
      found.set(tokenId, mark)
    }
  }

  const out: MarkRow[] = []
  for (const [tokenId, mark] of found) {
    if (!mark) continue
    for (const assetId of byToken.get(tokenId) ?? []) {
      out.push({ assetId, price: mark.price, quote: 'PKR', observedAt: mark.observedAt, source: 'platform' })
    }
  }
  return out
}

/** The user's own entered price wins when it is at least as recent; otherwise the platform trade price is used. */
export function mergeMarks(manual: MarkRow[], platform: MarkRow[]): MarkRow[] {
  const best = new Map<string, MarkRow>()
  for (const p of [...platform, ...manual]) {
    const cur = best.get(p.assetId)
    if (!cur || p.observedAt.getTime() >= cur.observedAt.getTime()) best.set(p.assetId, p)
  }
  return [...best.values()]
}

/** Logo of the linked platform token, by tracker asset id. */
export async function logosFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<Map<string, string>> {
  const ids = [...new Set(links.flatMap((l) => (l.ctmTokenId ? [l.ctmTokenId] : [])))]
  if (ids.length === 0) return new Map()
  const tokens = await db.ctmToken.findMany({ where: { id: { in: ids } }, select: { id: true, logoUrl: true } })
  const logo = new Map(tokens.flatMap((t) => (t.logoUrl ? [[t.id, t.logoUrl] as const] : [])))
  return new Map(links.flatMap((l) => (l.ctmTokenId && logo.has(l.ctmTokenId) ? [[l.id, logo.get(l.ctmTokenId)!] as const] : [])))
}
