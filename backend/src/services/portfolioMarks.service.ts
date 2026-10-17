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

/** How many of a token's most recent settled trades are examined for proven prices. */
export const PRICE_LOOKBACK_TRADES = 200
const LOOKUP_PARALLEL = 5
// Short, so a trade that just settled shows in the portfolio within seconds. It is not cleared by the trade
// itself on purpose: that would put portfolio code into the trade-completion path.
const CACHE_TTL_MS = 15_000

interface Point { price: string; observedAt: Date }
/** Proven trade prices of a token, newest first. */
const cache = new Map<string, { at: number; series: Point[] }>()
/** Test hook. */
export function resetPlatformMarkCache(): void { cache.clear() }

/**
 * Proven trade prices (PKR per token, newest first) for each token.
 *
 * A price comes only from a trade the portfolio import would also accept as settled: not disputed,
 * not auto-completed by the timer, not force-completed by an administrator, and, for on-chain
 * settlement, with a verified token transfer. A status of "completed" alone does not prove that
 * money and tokens both moved, and one unproven trade must not set what everyone's holdings are
 * worth. A token with no proven trade among its recent ones has an empty series.
 */
async function provenSeries(tokenIds: string[]): Promise<Map<string, Point[]>> {
  const now = Date.now()
  const out = new Map<string, Point[]>()
  const missing: string[] = []
  for (const tokenId of tokenIds) {
    const c = cache.get(tokenId)
    if (c && now - c.at < CACHE_TTL_MS) out.set(tokenId, c.series)
    else missing.push(tokenId)
  }
  // One query per token (a few at a time), so a very busy token cannot crowd out the others' recent trades.
  for (let i = 0; i < missing.length; i += LOOKUP_PARALLEL) {
    await Promise.all(missing.slice(i, i + LOOKUP_PARALLEL).map(async (tokenId) => {
      const trades = await db.ctmTrade.findMany({
        where: { tokenId, status: 'completed', completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        take: PRICE_LOOKBACK_TRADES,
        select: TRADE_FACTS_SELECT,
      })
      const forced = await forcedReleaseRefs(trades.map((t) => t.tradeRef))
      const series: Point[] = []
      for (const t of trades) {
        // The buyer's view is used only to ask "did this trade settle?"; the price is the same for both sides.
        if (classifyTrade(factsFromTrade(t, t.buyerId, forced)).kind !== 'eligible') continue
        const qty = new D(t.tokenAmount.toFixed())
        const fiat = new D(t.fiatAmount.toFixed())
        if (!qty.gt(0) || !fiat.gt(0) || !t.completedAt) continue
        const price = fiat.div(qty).toDecimalPlaces(ALLOC_DP, ROUND)
        if (!price.gt(0)) continue
        series.push({ price: price.toFixed(), observedAt: t.completedAt })
      }
      cache.set(tokenId, { at: now, series })
      out.set(tokenId, series)
    }))
  }
  return out
}

function tokenLinks(links: Array<{ id: string; ctmTokenId: string | null }>): Map<string, string[]> {
  const byToken = new Map<string, string[]>()
  for (const l of links) {
    if (l.ctmTokenId) byToken.set(l.ctmTokenId, [...(byToken.get(l.ctmTokenId) ?? []), l.id])
  }
  return byToken
}

/** Latest proven platform trade price (PKR per token) for each linked tracker token. */
export async function platformMarksFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<MarkRow[]> {
  const byToken = tokenLinks(links)
  if (byToken.size === 0) return []
  const series = await provenSeries([...byToken.keys()])
  const out: MarkRow[] = []
  for (const [tokenId, assetIds] of byToken) {
    const latest = series.get(tokenId)?.[0]
    if (!latest) continue
    for (const assetId of assetIds) out.push({ assetId, price: latest.price, quote: 'PKR', observedAt: latest.observedAt, source: 'platform' })
  }
  return out
}

/**
 * Every proven trade price of each linked token (newest first), as dated observations, so the
 * value-over-time chart can use the price that was current on past dates. Nothing is interpolated.
 */
export async function platformHistoryFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<MarkRow[]> {
  const byToken = tokenLinks(links)
  if (byToken.size === 0) return []
  const series = await provenSeries([...byToken.keys()])
  const out: MarkRow[] = []
  for (const [tokenId, assetIds] of byToken) {
    for (const point of series.get(tokenId) ?? []) {
      for (const assetId of assetIds) out.push({ assetId, price: point.price, quote: 'PKR', observedAt: point.observedAt, source: 'platform' })
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

/**
 * Public catalog page slug of the linked platform token, by tracker asset id. Only approved tokens are
 * exposed (their page is public); the platform token id itself is never returned.
 */
export async function slugsFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<Map<string, string>> {
  const ids = [...new Set(links.flatMap((l) => (l.ctmTokenId ? [l.ctmTokenId] : [])))]
  if (ids.length === 0) return new Map()
  const tokens = await db.ctmToken.findMany({ where: { id: { in: ids }, status: 'approved' }, select: { id: true, slug: true } })
  const slug = new Map(tokens.map((t) => [t.id, t.slug] as const))
  return new Map(links.flatMap((l) => (l.ctmTokenId && slug.has(l.ctmTokenId) ? [[l.id, slug.get(l.ctmTokenId)!] as const] : [])))
}
