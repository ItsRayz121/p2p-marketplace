import { db } from '../lib/prisma'
import { planUsdtImport, USDT_ASSET_KEY, USDT_SOURCE, type UsdtTradeFacts } from '../lib/portfolio/usdtImport'
import { disputeBlocksImport } from '../lib/portfolio/disputeRule'
import type { ImportPreviewItem } from './portfolioImport.service'

/**
 * Copies the caller's RELEASED, never-disputed P2P USDT trades into their private tracker as one "Tether USDT" holding.
 *
 * Strictly one-way and read-only toward the platform: it only reads Trade rows and writes the user's own
 * portfolio tables (never a trade, wallet, order, dispute or settlement record). Rules: lib/portfolio/usdtImport.ts.
 */

export const MAX_USDT_TRADES_SCANNED = 2000

export interface UsdtImportReport {
  created: number
  restored: number
  voided: number
  alreadyImported: number
  /** True once any USDT trade has been imported for this user. */
  hasImportedBefore: boolean
  preview: ImportPreviewItem[]
  skippedForLimit: number
}

/** The user's USDT holding, created on first use. Display details are fixed here and never taken from input. */
export async function ensureUsdtAsset(userId: string, opts: { maxAssets: number }): Promise<string | null> {
  const found = await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: USDT_ASSET_KEY }, select: { id: true } })
  if (found) return found.id
  if ((await db.portfolioAsset.count({ where: { userId } })) >= opts.maxAssets) return null
  try {
    const created = await db.portfolioAsset.create({ data: { userId, ctmTokenId: USDT_ASSET_KEY, name: 'Tether USDT', symbol: 'USDT' }, select: { id: true } })
    return created.id
  } catch {
    // Lost a race with a parallel request: the holding now exists, so use it.
    const again = await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: USDT_ASSET_KEY }, select: { id: true } })
    return again?.id ?? null
  }
}

async function loadFacts(userId: string): Promise<UsdtTradeFacts[]> {
  const trades = await db.trade.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }], coin: { equals: 'USDT', mode: 'insensitive' }, status: { not: 'cancelled' } },
    orderBy: { createdAt: 'asc' },
    take: MAX_USDT_TRADES_SCANNED,
    select: {
      id: true, orderRef: true, buyerId: true, sellerId: true, coin: true, status: true, amount: true, fiatAmount: true, releasedAt: true,
      dispute: { select: { id: true, status: true, resolutionType: true } },
    },
  })
  return trades.map((t) => ({
    id: t.id, orderRef: t.orderRef, userId, buyerId: t.buyerId, sellerId: t.sellerId, coin: t.coin, status: t.status,
    amount: t.amount.toFixed(), fiatAmount: t.fiatAmount.toFixed(), releasedAt: t.releasedAt, hasDispute: disputeBlocksImport(t.dispute),
  }))
}

export async function runUsdtImport(
  userId: string,
  opts: { dryRun: boolean; maxAssets: number; maxEvents: number },
): Promise<UsdtImportReport> {
  const facts = await loadFacts(userId)
  const existing = await db.portfolioEvent.findMany({ where: { userId, source: USDT_SOURCE }, select: { id: true, sourceRef: true, voidedAt: true } })
  const plan = planUsdtImport(facts, existing.filter((e): e is typeof e & { sourceRef: string } => e.sourceRef !== null))

  // Respect per-user limits instead of failing half-way.
  const hasAsset = Boolean(await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: USDT_ASSET_KEY }, select: { id: true } }))
  const totalAssets = await db.portfolioAsset.count({ where: { userId } })
  const totalEvents = await db.portfolioEvent.count({ where: { userId } })
  const assetFits = hasAsset || totalAssets < opts.maxAssets
  let eventRoom = Math.max(0, opts.maxEvents - totalEvents)
  let skipped = 0
  const creatable = plan.toCreate.filter(() => {
    if (!assetFits || eventRoom <= 0) { skipped += 1; return false }
    eventRoom -= 1
    return true
  })

  const report: UsdtImportReport = {
    created: creatable.length,
    restored: plan.toRestore.length,
    voided: plan.toVoid.length,
    alreadyImported: plan.alreadyImported,
    hasImportedBefore: existing.length > 0,
    preview: creatable.slice(0, 20).map((s) => ({
      tradeRef: facts.find((f) => f.id === s.sourceRef)?.orderRef ?? s.sourceRef, tokenName: 'Tether USDT', type: s.type,
      quantity: s.quantity, consideration: s.consideration, quote: s.quote, date: s.occurredAt.toISOString(),
    })),
    skippedForLimit: skipped,
  }
  if (opts.dryRun) return report

  if (creatable.length > 0) {
    const assetId = await ensureUsdtAsset(userId, { maxAssets: opts.maxAssets })
    if (assetId) {
      await db.portfolioEvent.createMany({
        data: creatable.map((s) => ({
          userId, assetId, type: s.type, occurredAt: s.occurredAt, quantity: s.quantity, consideration: s.consideration,
          fee: '0', zeroCost: false, quote: s.quote, fxRate: s.fxRate, fxSource: 'platform', note: s.note, source: USDT_SOURCE, sourceRef: s.sourceRef,
        })),
        skipDuplicates: true,
      })
    }
  }
  if (plan.toRestore.length > 0) {
    await db.portfolioEvent.updateMany({ where: { id: { in: plan.toRestore }, userId, source: USDT_SOURCE }, data: { voidedAt: null, voidReason: null } })
  }
  const byReason = new Map<string, string[]>()
  for (const v of plan.toVoid) byReason.set(v.reason, [...(byReason.get(v.reason) ?? []), v.eventId])
  for (const [reason, ids] of byReason) {
    await db.portfolioEvent.updateMany({ where: { id: { in: ids }, userId, source: USDT_SOURCE }, data: { voidedAt: new Date(), voidReason: reason } })
  }
  return { ...report, hasImportedBefore: report.hasImportedBefore || creatable.length > 0 }
}
