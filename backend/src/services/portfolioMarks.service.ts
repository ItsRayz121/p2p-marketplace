import { db } from '../lib/prisma'
import { D, ALLOC_DP, ROUND } from '../lib/portfolio/decimal'
import type { Quote } from '../lib/portfolio/currency'

/**
 * Read-only helpers that let a tracked token that mirrors a RupChain token use the platform's own data:
 * the price of the latest settled trade of that token, and the token's logo. Nothing here writes anything.
 */

export interface MarkRow { assetId: string; price: string; quote: Quote; observedAt: Date }

/** Latest settled platform trade price (PKR per token) for each linked tracker token. */
export async function platformMarksFor(links: Array<{ id: string; ctmTokenId: string | null }>): Promise<MarkRow[]> {
  const byToken = new Map<string, string[]>()
  for (const l of links) {
    if (l.ctmTokenId) byToken.set(l.ctmTokenId, [...(byToken.get(l.ctmTokenId) ?? []), l.id])
  }
  if (byToken.size === 0) return []
  const trades = await db.ctmTrade.findMany({
    where: { tokenId: { in: [...byToken.keys()] }, status: 'completed', completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
    distinct: ['tokenId'],
    select: { tokenId: true, tokenAmount: true, fiatAmount: true, completedAt: true },
  })
  const out: MarkRow[] = []
  for (const t of trades) {
    const qty = new D(t.tokenAmount.toFixed())
    const fiat = new D(t.fiatAmount.toFixed())
    if (!qty.gt(0) || !fiat.gt(0) || !t.completedAt) continue
    const price = fiat.div(qty).toDecimalPlaces(ALLOC_DP, ROUND)
    if (!price.gt(0)) continue
    for (const assetId of byToken.get(t.tokenId) ?? []) {
      out.push({ assetId, price: price.toFixed(), quote: 'PKR', observedAt: t.completedAt })
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
