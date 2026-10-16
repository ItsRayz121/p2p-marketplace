import { db } from '../lib/prisma'
import { parseSourceUrl, validateCustomAsset } from '../lib/portfolioAsset'
import { makePlan, type AttentionReason, type CtmTradeFacts, type ImportPlan } from '../lib/portfolio/ctmImport'

/**
 * Copies the caller's SETTLED RupChain CTM trades into their private tracker.
 *
 * Strictly one-way and read-only toward the platform: this file never writes to ctmTrade, wallets,
 * transactions, disputes, payouts, bonds or the audit log. It only reads trades, and writes the
 * user's own portfolio tables. Eligibility rules live in lib/portfolio/ctmImport.ts.
 */

export const MAX_TRADES_SCANNED = 2000
const AUDIT_CHUNK = 100

export interface ImportPreviewItem {
  tradeRef: string
  tokenName: string
  type: 'BUY' | 'SELL'
  quantity: string
  consideration: string
  quote: 'PKR' | 'USDT'
  date: string
}

export interface ImportReport {
  dryRun: boolean
  created: number
  restored: number
  voided: number
  alreadyImported: number
  attention: Array<{ reason: AttentionReason; count: number }>
  /** True once any trade has been imported for this user (the app then keeps the tracker in sync automatically). */
  hasImportedBefore: boolean
  /** First few entries that would be / were added, for the confirmation prompt. */
  preview: ImportPreviewItem[]
  /** Entries skipped because a per-user limit was reached. */
  skippedForLimit: number
}

interface TokenMeta {
  id: string
  name: string
  symbol: string
  network: string | null
  contractAddress: string | null
  officialWebsite: string | null
}

async function loadFacts(userId: string): Promise<{ facts: CtmTradeFacts[]; tokens: Map<string, TokenMeta>; refs: Map<string, string> }> {
  const trades = await db.ctmTrade.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: { notIn: ['cancelled', 'expired'] } },
    orderBy: { createdAt: 'asc' },
    take: MAX_TRADES_SCANNED,
    select: {
      id: true, tradeRef: true, displayRef: true, buyerId: true, sellerId: true, status: true, settlementType: true,
      completedAt: true, tokenId: true, tokenAmount: true, fiatAmount: true, paymentCurrency: true, usdtAmount: true,
      token: { select: { id: true, name: true, symbol: true, network: true, contractAddress: true, officialWebsite: true } },
      dispute: { select: { id: true } },
      messages: { where: { isSystem: true, message: { startsWith: 'Trade auto-completed' } }, select: { id: true }, take: 1 },
      proofs: { where: { proofType: 'txhash', txVerificationStatus: 'verified' }, select: { id: true }, take: 1 },
    },
  })

  // Administrator force-completions are recorded in the audit log by trade reference.
  const completedRefs = trades.filter((t) => t.status === 'completed').map((t) => t.tradeRef)
  const forced = new Set<string>()
  for (let i = 0; i < completedRefs.length; i += AUDIT_CHUNK) {
    const chunk = completedRefs.slice(i, i + AUDIT_CHUNK)
    const rows = await db.auditLog.findMany({
      where: { action: 'CTM_ADMIN_FORCE_RELEASE', OR: chunk.map((r) => ({ metadata: { path: ['tradeRef'], equals: r } })) },
      select: { metadata: true },
    })
    for (const r of rows) {
      const ref = (r.metadata as { tradeRef?: unknown } | null)?.tradeRef
      if (typeof ref === 'string') forced.add(ref)
    }
  }

  const tokens = new Map<string, TokenMeta>()
  const refs = new Map<string, string>()
  const facts = trades.map((t): CtmTradeFacts => {
    tokens.set(t.token.id, t.token)
    refs.set(t.id, t.displayRef ?? t.tradeRef)
    return {
      id: t.id,
      displayRef: t.displayRef,
      userId,
      buyerId: t.buyerId,
      sellerId: t.sellerId,
      status: t.status,
      settlementType: t.settlementType,
      completedAt: t.completedAt,
      tokenId: t.tokenId,
      tokenAmount: t.tokenAmount.toFixed(),
      fiatAmount: t.fiatAmount.toFixed(),
      paymentCurrency: t.paymentCurrency,
      usdtAmount: t.usdtAmount ? t.usdtAmount.toFixed() : null,
      hasDispute: Boolean(t.dispute),
      adminForceCompleted: forced.has(t.tradeRef),
      autoCompleted: t.messages.length > 0,
      verifiedTokenProof: t.proofs.length > 0,
    }
  })
  return { facts, tokens, refs }
}

/** A linked tracker token mirroring a platform token. Display fields are re-validated, never trusted. */
function assetDataFor(t: TokenMeta) {
  const base = validateCustomAsset({ name: t.name, symbol: t.symbol, network: t.network ?? '', contractAddress: t.contractAddress ?? '' })
  if (base.ok) {
    const site = t.officialWebsite ? parseSourceUrl(t.officialWebsite) : null
    return { ...base.value, sourceUrl: site?.ok ? site.href : null }
  }
  // Fall back to just a clean name if the platform's optional fields don't pass our stricter checks.
  const nameOnly = validateCustomAsset({ name: t.name })
  return nameOnly.ok ? nameOnly.value : { name: 'RupChain token', symbol: null, sourceUrl: null, network: null, contractAddress: null }
}

export async function runCtmImport(
  userId: string,
  opts: { dryRun: boolean; maxAssets: number; maxEvents: number },
): Promise<ImportReport> {
  const { facts, tokens, refs } = await loadFacts(userId)
  const existing = await db.portfolioEvent.findMany({
    where: { userId, source: 'ctm' },
    select: { id: true, sourceRef: true, voidedAt: true },
  })
  const plan: ImportPlan = makePlan(
    facts,
    existing.filter((e): e is typeof e & { sourceRef: string } => e.sourceRef !== null),
  )

  // Respect per-user limits instead of failing half-way.
  const linked = await db.portfolioAsset.findMany({ where: { userId, ctmTokenId: { not: null } }, select: { id: true, ctmTokenId: true } })
  const assetByToken = new Map(linked.map((a) => [a.ctmTokenId!, a.id]))
  const totalAssets = await db.portfolioAsset.count({ where: { userId } })
  const totalEvents = await db.portfolioEvent.count({ where: { userId } })
  let assetRoom = Math.max(0, opts.maxAssets - totalAssets)
  let eventRoom = Math.max(0, opts.maxEvents - totalEvents)
  let skipped = 0
  const creatable = plan.toCreate.filter((spec) => {
    if (eventRoom <= 0) { skipped += 1; return false }
    if (!assetByToken.has(spec.assetKey)) {
      if (assetRoom <= 0) { skipped += 1; return false }
      assetRoom -= 1
      assetByToken.set(spec.assetKey, '__pending__')
    }
    eventRoom -= 1
    return true
  })
  const hasImportedBefore = existing.length > 0

  const preview: ImportPreviewItem[] = creatable.slice(0, 20).map((s) => ({
    tradeRef: refs.get(s.sourceRef) ?? s.sourceRef,
    tokenName: tokens.get(s.assetKey)?.name ?? 'Token',
    type: s.type,
    quantity: s.quantity,
    consideration: s.consideration,
    quote: s.quote,
    date: s.occurredAt.toISOString(),
  }))

  const report: ImportReport = {
    dryRun: opts.dryRun,
    created: creatable.length,
    restored: plan.toRestore.length,
    voided: plan.toVoid.length,
    alreadyImported: plan.alreadyImported,
    attention: plan.attention,
    hasImportedBefore,
    preview,
    skippedForLimit: skipped,
  }
  if (opts.dryRun) return report

  // ── apply (user's own tables only; idempotent through unique (userId, source, sourceRef)) ──
  const tokenIds = [...new Set(creatable.map((s) => s.assetKey))]
  const assetIds = new Map<string, string>(linked.map((a) => [a.ctmTokenId!, a.id]))
  for (const tokenId of tokenIds) {
    if (assetIds.has(tokenId)) continue
    const meta = tokens.get(tokenId)
    if (!meta) continue
    try {
      const created = await db.portfolioAsset.create({ data: { userId, ctmTokenId: tokenId, ...assetDataFor(meta) }, select: { id: true } })
      assetIds.set(tokenId, created.id)
    } catch {
      // Lost a race with a parallel import: the linked token now exists, so use it.
      const again = await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: tokenId }, select: { id: true } })
      if (again) assetIds.set(tokenId, again.id)
    }
  }

  const rows = creatable.flatMap((s) => {
    const assetId = assetIds.get(s.assetKey)
    if (!assetId) return []
    return [{
      userId,
      assetId,
      type: s.type,
      occurredAt: s.occurredAt,
      quantity: s.quantity,
      consideration: s.consideration,
      fee: '0', // CTM records no per-trade platform fee, so none is invented here
      zeroCost: false,
      quote: s.quote,
      fxRate: s.fxRate,
      fxSource: s.fxRate ? 'platform' : null,
      note: s.note,
      source: 'ctm',
      sourceRef: s.sourceRef,
    }]
  })
  if (rows.length > 0) await db.portfolioEvent.createMany({ data: rows, skipDuplicates: true })

  if (plan.toRestore.length > 0) {
    await db.portfolioEvent.updateMany({ where: { id: { in: plan.toRestore }, userId, source: 'ctm' }, data: { voidedAt: null, voidReason: null } })
  }
  const byReason = new Map<string, string[]>()
  for (const v of plan.toVoid) byReason.set(v.reason, [...(byReason.get(v.reason) ?? []), v.eventId])
  for (const [reason, ids] of byReason) {
    await db.portfolioEvent.updateMany({ where: { id: { in: ids }, userId, source: 'ctm' }, data: { voidedAt: new Date(), voidReason: reason } })
  }
  return { ...report, hasImportedBefore: hasImportedBefore || rows.length > 0 }
}
