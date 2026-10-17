import { db } from '../lib/prisma'
import { parseSourceUrl, validateCustomAsset } from '../lib/portfolioAsset'
import { forcedReleaseRefs, factsFromTrade, TRADE_FACTS_SELECT } from './ctmTradeFacts.service'
import { chooseFxStamp } from '../lib/portfolio/currency'
import { getStringConfig } from './platformFlags.service'
import { classifyTrade, describeTrade, makePlan, type AttentionReason, type CtmTradeFacts, type ImportPlan } from '../lib/portfolio/ctmImport'

/**
 * Copies the caller's SETTLED RupChain CTM trades into their private tracker.
 *
 * Strictly one-way and read-only toward the platform: this file never writes to ctmTrade, wallets,
 * transactions, disputes, payouts, bonds or the audit log. It only reads trades, and writes the
 * user's own portfolio tables. Eligibility rules live in lib/portfolio/ctmImport.ts.
 */

export const MAX_TRADES_SCANNED = 2000

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
  /** Trades you recorded by hand: they are not imported a second time. */
  recordedManually: number
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
      ...TRADE_FACTS_SELECT,
      token: { select: { id: true, name: true, symbol: true, network: true, contractAddress: true, officialWebsite: true } },
    },
  })

  // Administrator force-completions are recorded in the audit log by trade reference.
  const forced = await forcedReleaseRefs(trades.filter((t) => t.status === 'completed').map((t) => t.tradeRef))

  const tokens = new Map<string, TokenMeta>()
  const refs = new Map<string, string>()
  const facts = trades.map((t): CtmTradeFacts => {
    tokens.set(t.token.id, t.token)
    refs.set(t.id, t.displayRef ?? t.tradeRef)
    return factsFromTrade(t, userId, forced)
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
  // Trades the user already recorded by hand (for a trade that was left out) must not be imported as well.
  const byHand = await db.portfolioEvent.findMany({
    where: { userId, source: 'manual', linkedTradeRef: { not: null } },
    select: { linkedTradeRef: true },
  })
  const plan: ImportPlan = makePlan(
    facts,
    existing.filter((e): e is typeof e & { sourceRef: string } => e.sourceRef !== null),
    new Set(byHand.flatMap((e) => (e.linkedTradeRef ? [e.linkedTradeRef] : []))),
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
    recordedManually: plan.recordedManually,
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

// ── Review of trades left out of automatic tracking ──────────────────────────────────────────────

export interface ExcludedTrade {
  /** CTM trade id: the stable reference a manual record is linked to. */
  tradeId: string
  /** Reference shown to the user (the trade's display reference). */
  tradeRef: string
  tokenName: string
  side: 'BUY' | 'SELL'
  quantity: string
  /** Null when the amount cannot be shown safely. */
  consideration: string | null
  quote: 'PKR' | 'USDT'
  /** When the trade finished, or was opened if it never finished. */
  date: string | null
  reason: AttentionReason
  /** The user already recorded this trade by hand. */
  recorded: boolean
  /** The user may record it by hand: false while unfinished, or when the amounts cannot be used. */
  canRecord: boolean
}

interface ExcludedInternal extends ExcludedTrade {
  /** PKR per 1 USDT the trade itself was done at (USDT-paid trades only). */
  fxRate: string | null
  token: TokenMeta | undefined
}

/** Every trade of the user that was left out of automatic tracking, newest first (read-only). */
async function computeExcluded(userId: string): Promise<ExcludedInternal[]> {
  const { facts, tokens, refs } = await loadFacts(userId)
  const byHand = new Set(
    (await db.portfolioEvent.findMany({ where: { userId, source: 'manual', linkedTradeRef: { not: null } }, select: { linkedTradeRef: true } }))
      .flatMap((e) => (e.linkedTradeRef ? [e.linkedTradeRef] : [])),
  )
  const all: ExcludedInternal[] = []
  for (const f of facts) {
    const c = classifyTrade(f)
    if (c.kind !== 'attention') continue
    const d = describeTrade(f)
    if (!d) continue
    all.push({
      tradeId: f.id,
      tradeRef: refs.get(f.id) ?? f.id,
      tokenName: tokens.get(f.tokenId)?.name ?? 'Token',
      side: d.side,
      quantity: d.quantity,
      consideration: d.consideration,
      quote: d.quote,
      date: (f.completedAt ?? f.createdAt ?? null)?.toISOString() ?? null,
      reason: c.reason,
      recorded: byHand.has(f.id),
      canRecord: c.reason !== 'in_progress' && c.reason !== 'invalid_amounts' && d.consideration !== null,
      fxRate: d.fxRate,
      token: tokens.get(f.tokenId),
    })
  }
  all.sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? '') || (a.tradeId < b.tradeId ? -1 : 1))
  return all
}

const isRecordable = (t: ExcludedTrade) => t.canRecord && !t.recorded

/** Trades that were not added automatically, newest first, for the review list (read-only). */
export async function listExcludedTrades(userId: string, opts: { limit: number; offset: number }): Promise<{ total: number; recordable: number; items: ExcludedTrade[] }> {
  const all = await computeExcluded(userId)
  const items = all.slice(opts.offset, opts.offset + opts.limit).map(({ fxRate: _fx, token: _t, ...t }) => t)
  return { total: all.length, recordable: all.filter(isRecordable).length, items }
}

export type BatchOutcome = 'recorded' | 'already_recorded' | 'skipped' | 'failed'
export interface BatchResult { tradeId: string; tradeRef: string; outcome: BatchOutcome; message?: string }
export interface BatchReport { recorded: number; alreadyRecorded: number; skipped: number; failed: number; results: BatchResult[] }

/**
 * Record several left-out trades in the caller's own tracker, using the amounts the platform holds
 * for each trade. Every trade is its own unit of work: the database lets exactly one entry per trade
 * through (unique userId + linkedTradeRef), so a retry after a partial failure never duplicates an
 * entry. Nothing here changes a trade, a dispute, a wallet or a payment.
 */
export async function recordExcludedBatch(
  userId: string,
  selection: { all: true } | { tradeIds: string[] },
  opts: { maxAssets: number; maxEvents: number },
): Promise<BatchReport> {
  const everything = await computeExcluded(userId)
  const byId = new Set('tradeIds' in selection ? selection.tradeIds : [])
  const wanted = 'all' in selection ? everything.filter(isRecordable) : everything.filter((t) => byId.has(t.tradeId))
  const known = new Set(everything.map((t) => t.tradeId))
  const results: BatchResult[] = []
  for (const id of byId) {
    if (!known.has(id)) results.push({ tradeId: id, tradeRef: id, outcome: 'failed', message: 'Trade not found, or it already counts automatically.' })
  }

  let room = Math.max(0, opts.maxEvents - (await db.portfolioEvent.count({ where: { userId } })))
  const platformRate = await getStringConfig('rate_USDT_PKR', '')
  for (const t of wanted) {
    const base = { tradeId: t.tradeId, tradeRef: t.tradeRef }
    if (t.recorded) { results.push({ ...base, outcome: 'already_recorded' }); continue }
    if (!t.canRecord || t.consideration === null || !t.token || !t.date) {
      results.push({ ...base, outcome: 'skipped', message: t.reason === 'in_progress' ? 'Not finished yet.' : 'The amounts of this trade cannot be used.' })
      continue
    }
    if (room <= 0) { results.push({ ...base, outcome: 'failed', message: 'Entry limit reached.' }); continue }
    try {
      const assetId = await ensureLinkedAsset(userId, t.token, { maxAssets: opts.maxAssets })
      if (!assetId) { results.push({ ...base, outcome: 'failed', message: 'Token limit reached.' }); continue }
      const occurredAt = new Date(t.date)
      const stamp = t.fxRate
        ? { fxRate: t.fxRate, fxSource: 'platform' as const }
        : chooseFxStamp({ userRate: null, platformRate, occurredAtMs: occurredAt.getTime(), nowMs: Date.now() })
      await db.portfolioEvent.create({
        data: {
          userId, assetId, type: t.side, occurredAt, quantity: t.quantity, consideration: t.consideration, fee: '0',
          basis: null, zeroCost: false, quote: t.quote, fxRate: stamp.fxRate, fxSource: stamp.fxSource,
          note: `Recorded from RupChain trade ${t.tradeRef}`, linkedTradeRef: t.tradeId,
        },
        select: { id: true },
      })
      room -= 1
      results.push({ ...base, outcome: 'recorded' })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') results.push({ ...base, outcome: 'already_recorded' })
      else results.push({ ...base, outcome: 'failed', message: 'Could not be saved. Try again.' })
    }
  }
  const count = (o: BatchOutcome) => results.filter((r) => r.outcome === o).length
  return { recorded: count('recorded'), alreadyRecorded: count('already_recorded'), skipped: count('skipped'), failed: count('failed'), results }
}

export type RecordCheck =
  | { ok: true; side: 'BUY' | 'SELL'; token: TokenMeta; tradeId: string; fxRate: string | null }
  | { ok: false; status: 404 | 409; message: string }

/**
 * May the caller record this trade by hand? Only a trade of theirs that was left out of automatic
 * tracking and has finished (disputed, timer- or admin-completed, unverified transfer). A trade that
 * counts automatically, never happened, or has not finished cannot be recorded this way.
 */
export async function checkExcludedTradeRecordable(userId: string, tradeId: string): Promise<RecordCheck> {
  const trade = await db.ctmTrade.findFirst({
    where: { id: tradeId, OR: [{ buyerId: userId }, { sellerId: userId }] },
    select: {
      ...TRADE_FACTS_SELECT,
      token: { select: { id: true, name: true, symbol: true, network: true, contractAddress: true, officialWebsite: true } },
    },
  })
  if (!trade) return { ok: false, status: 404, message: 'Trade not found' }
  const forced = await forcedReleaseRefs(trade.status === 'completed' ? [trade.tradeRef] : [])
  const facts = factsFromTrade(trade, userId, forced)
  const c = classifyTrade(facts)
  if (c.kind === 'ignore') return { ok: false, status: 409, message: 'Nothing was exchanged in this trade, so there is nothing to record.' }
  if (c.kind === 'eligible') return { ok: false, status: 409, message: 'This trade is added to your portfolio automatically.' }
  if (c.reason === 'in_progress') return { ok: false, status: 409, message: 'This trade has not finished yet. Record it once it has.' }
  const d = describeTrade(facts)
  if (!d || c.reason === 'invalid_amounts') return { ok: false, status: 409, message: 'The amounts of this trade cannot be used. Record it as a normal entry instead.' }
  return { ok: true, side: d.side, token: trade.token, tradeId: trade.id, fxRate: d.fxRate }
}

/** The caller's tracker token that mirrors this platform token, created on first use (their own tables only). */
export async function ensureLinkedAsset(userId: string, token: TokenMeta, opts: { maxAssets: number }): Promise<string | null> {
  const found = await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: token.id }, select: { id: true } })
  if (found) return found.id
  if ((await db.portfolioAsset.count({ where: { userId } })) >= opts.maxAssets) return null
  try {
    const created = await db.portfolioAsset.create({ data: { userId, ctmTokenId: token.id, ...assetDataFor(token) }, select: { id: true } })
    return created.id
  } catch {
    // Lost a race with a parallel request: the linked token now exists, so use it.
    const again = await db.portfolioAsset.findFirst({ where: { userId, ctmTokenId: token.id }, select: { id: true } })
    return again?.id ?? null
  }
}
