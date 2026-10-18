import type { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { cleanRate, type Quote } from '../lib/portfolio/currency'
import { D } from '../lib/portfolio/decimal'
import { toSummaryRow, type DbEvent } from '../lib/portfolio/rows'
import type { EventRow } from '../lib/portfolio/summaryBuilder'
import {
  computeBaseline, findAliasGroups, openingRows, walletContext,
  type BaselineAsset, type Reconciliation, type ReconciliationDiscrepancy,
} from '../lib/portfolio/period'
import { minuteBucket, valueHoldings, type MarkInput } from '../lib/portfolio/snapshot'
import { USDT_ASSET_KEY } from '../lib/portfolio/usdtImport'
import { getStringConfig } from './platformFlags.service'
import { latestMarksForUser, type MarkRow } from './portfolioMarks.service'

/**
 * Tracking periods: reading the active one, the one-time cutover that creates it (archiving what came before
 * into an opening baseline), and rolling a cutover back. Analytical tables only: nothing here writes custody,
 * orders or settlement data. The cutover reads wallet and listing figures as CONTEXT for the reconciliation
 * record (read-only, fail-soft) and never lets them change a holding.
 */

export const DEFAULT_TIMEZONE = 'Asia/Karachi'

export interface HoldingView {
  id: string
  assetId: string
  quantity: string
  lots: unknown
  market: { price: string | null; quote: Quote | null; source: string | null; observedAt: Date | null }
}

export interface PeriodView {
  id: string
  version: number
  reason: string
  startedAt: Date
  timezone: string
  fxUsdtPkr: string | null
  fxSource: string | null
  reconciliation: unknown
  holdings: HoldingView[]
}

/**
 * The user's active period, or null when they have none yet (the portfolio then behaves exactly as before the
 * tracking-period feature). A failure to read is treated the same way and logged, so a deployment that is
 * briefly ahead of its database migration keeps the portfolio working instead of breaking it.
 */
export async function getActivePeriod(userId: string): Promise<PeriodView | null> {
  try {
    const p = await db.portfolioTrackingPeriod.findFirst({
      where: { userId, status: 'active' },
      orderBy: { version: 'desc' },
      include: { holdings: true },
    })
    if (!p) return null
    return {
      id: p.id,
      version: p.version,
      reason: p.reason,
      startedAt: p.startedAt,
      timezone: p.timezone,
      fxUsdtPkr: p.fxUsdtPkr?.toFixed() ?? null,
      fxSource: p.fxSource,
      reconciliation: p.reconciliation,
      holdings: p.holdings.map((h) => ({
        id: h.id,
        assetId: h.assetId,
        quantity: h.quantity.toFixed(),
        lots: h.lots,
        market: {
          price: h.marketPrice?.toFixed() ?? null,
          quote: (h.marketQuote as Quote | null) ?? null,
          source: h.marketSource,
          observedAt: h.marketObservedAt,
        },
      })),
    }
  } catch (err) {
    logger.warn({ err, userId }, 'portfolio: could not read tracking period; using the unversioned portfolio')
    return null
  }
}

/** Entries recorded after the cutover but dated before it still count in the current period, from the cutover on. */
export function clampToPeriod(rows: EventRow[], startedAt: Date): EventRow[] {
  return rows.map((r) => (r.occurredAt.getTime() < startedAt.getTime() ? { ...r, occurredAt: startedAt } : r))
}

/**
 * The rows every number is built from: the opening baseline (with its actual costs) followed by the entries of
 * the current period. With no period it is simply every entry, as before.
 */
export function currentRows(args: {
  events: DbEvent[]
  period: PeriodView | null
  currency: Quote
  platformRate: string | null
  usdtAssets: ReadonlySet<string>
}): EventRow[] {
  const rows = args.events.map((e) => toSummaryRow(e, args.platformRate, args.usdtAssets))
  if (!args.period) return rows
  return [...openingRows(args.period.holdings, args.currency, args.period.startedAt), ...clampToPeriod(rows, args.period.startedAt)]
}

// ── Cutover ────────────────────────────────────────────────────────────────

export interface CutoverOptions {
  /** The cutover instant. */
  at: Date
  /** Compute and report only; write nothing. */
  dryRun?: boolean
  reason?: 'cutover' | 'new_portfolio'
}

export interface CutoverResult {
  status: 'created' | 'exists' | 'dry_run'
  periodId: string | null
  version: number | null
  startedAt: string
  timezone: string
  assetsInBaseline: number
  entriesArchived: number
  discrepancies: ReconciliationDiscrepancy[]
  holdings: Array<{ assetId: string; quantity: string; costKnown: boolean; hasOpeningQuote: boolean }>
}

const EVENT_FIELDS = {
  id: true, assetId: true, type: true, occurredAt: true, quantity: true, consideration: true, fee: true, basis: true,
  zeroCost: true, quote: true, fxRate: true, source: true, voidedAt: true,
} as const

async function validTimezone(): Promise<string> {
  const raw = (await getStringConfig('platform_timezone', DEFAULT_TIMEZONE).catch(() => DEFAULT_TIMEZONE)).trim() || DEFAULT_TIMEZONE
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw }); return raw } catch { return DEFAULT_TIMEZONE }
}

/**
 * Read-only context for the reconciliation record: the user's USDT wallet figures and open listings. A failure
 * leaves the context empty; it never blocks the cutover and never alters a holding.
 */
async function readCustodyContext(userId: string): Promise<Reconciliation['context']> {
  const empty: Reconciliation['context'] = { wallet: [], listings: [] }
  try {
    const wallets = await db.wallet.findMany({ where: { userId, coin: 'USDT' }, select: { coin: true, network: true, balance: true, lockedBalance: true } })
    const listings = await db.ctmListing.findMany({
      where: { merchantProfile: { userId }, status: 'active' },
      select: { tokenId: true, side: true, status: true, availableAmount: true, lockedAmount: true },
      take: 200,
    })
    return {
      wallet: walletContext(wallets.map((w) => ({ coin: w.coin, network: w.network, balance: w.balance.toFixed(), lockedBalance: w.lockedBalance.toFixed() }))),
      listings: listings.map((l) => ({ tokenId: l.tokenId, side: String(l.side), status: String(l.status), available: l.availableAmount.toFixed(), locked: l.lockedAmount.toFixed() })),
    }
  } catch (err) {
    logger.warn({ err, userId }, 'portfolio cutover: wallet/listing context unavailable')
    return empty
  }
}

function toMarkInputs(marks: MarkRow[]): Map<string, MarkInput> {
  return new Map(marks.map((m) => [m.assetId, { price: m.price, quote: m.quote, observedAt: m.observedAt }]))
}

/**
 * Create the user's first tracking period at `opts.at`.
 *
 * - Holdings are reconciled from the user's own entries (FIFO), never from a listing, a reservation or a wallet.
 * - Each held token keeps its ACTUAL remaining cost (unknown stays unknown) and separately records the quote it
 *   was valued at that day. The quote never replaces a known cost.
 * - Every entry dated up to the cutover instant is archived (kept, readable, exportable) in the same transaction,
 *   so nothing is lost and nothing is counted twice. An entry dated after it, or recorded while this runs, is not in
 *   the archived list: it stays in the current period.
 * - Idempotent: a user who already has an active period is left alone.
 */
export async function cutoverUser(userId: string, opts: CutoverOptions): Promise<CutoverResult> {
  if (opts.at.getTime() > Date.now() + 5 * 60_000) throw new Error('The cutover time cannot be in the future')
  const timezone = await validTimezone()
  const platformRate = cleanRate(await getStringConfig('rate_USDT_PKR', '').catch(() => ''))
  const marks = await latestMarksForUser(userId)
  const markByAsset = new Map(marks.map((m) => [m.assetId, m]))
  const custody = await readCustodyContext(userId)

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portfolio-restore:${userId}`}))`

    const active = await tx.portfolioTrackingPeriod.findFirst({ where: { userId, status: 'active' }, select: { id: true, version: true, startedAt: true, timezone: true } })
    if (active) {
      return {
        status: 'exists' as const, periodId: active.id, version: active.version, startedAt: active.startedAt.toISOString(), timezone: active.timezone,
        assetsInBaseline: 0, entriesArchived: 0, discrepancies: [], holdings: [],
      }
    }

    // The baseline is the state AS OF the cutover instant: entries dated after it (even if already recorded) are not
    // part of it and simply count in the new period; entries dated up to it are folded in and archived.
    const everything = await tx.portfolioEvent.findMany({ where: { userId, archivedInPeriodId: null }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], select: EVENT_FIELDS })
    const all = everything.filter((e) => e.occurredAt.getTime() <= opts.at.getTime())
    const counted = all.filter((e) => e.voidedAt === null)
    const assets = await tx.portfolioAsset.findMany({ where: { userId }, select: { id: true, name: true, symbol: true, network: true, contractAddress: true, ctmTokenId: true } })
    const usdtAssets = new Set(assets.filter((a) => a.ctmTokenId === USDT_ASSET_KEY).map((a) => a.id))

    const baseline = computeBaseline(counted.map((e) => toSummaryRow(e, platformRate, usdtAssets)))
    const held = baseline.filter((b) => b.lots.length > 0 && new D(b.quantity).gt(0))
    const nameOf = new Map(assets.map((a) => [a.id, a.name]))

    const discrepancies = reconcile({ baseline, held, assets, markByAsset, usdtAssets, custody, nameOf })
    const view = {
      status: 'dry_run' as const,
      periodId: null as string | null, version: null as number | null,
      startedAt: opts.at.toISOString(), timezone,
      assetsInBaseline: held.length, entriesArchived: all.length, discrepancies,
      holdings: held.map((b) => ({ assetId: b.assetId, quantity: b.quantity, costKnown: !b.basisUnknown, hasOpeningQuote: markByAsset.has(b.assetId) })),
    }
    if (opts.dryRun) return view

    const last = await tx.portfolioTrackingPeriod.findFirst({ where: { userId }, orderBy: { version: 'desc' }, select: { version: true } })
    const version = (last?.version ?? 0) + 1
    const reconciliation: Reconciliation = {
      version: 1,
      entriesCounted: counted.length,
      entriesVoided: all.length - counted.length,
      assetsWithHoldings: held.length,
      context: custody,
      discrepancies,
    }
    const period = await tx.portfolioTrackingPeriod.create({
      data: {
        userId, version, status: 'active', reason: opts.reason ?? 'cutover', startedAt: opts.at, timezone,
        fxUsdtPkr: platformRate, fxSource: platformRate ? 'platform' : null,
        reconciliation: reconciliation as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })

    if (held.length > 0) {
      await tx.portfolioOpeningHolding.createMany({
        data: held.map((b) => {
          const m = markByAsset.get(b.assetId)
          return {
            periodId: period.id, userId, assetId: b.assetId, quantity: b.quantity,
            lots: b.lots as unknown as Prisma.InputJsonValue,
            marketPrice: m?.price ?? null, marketQuote: m?.quote ?? null, marketSource: m?.source ?? null, marketObservedAt: m?.observedAt ?? null,
          }
        }),
      })
    }

    if (all.length > 0) {
      await tx.portfolioEvent.updateMany({ where: { userId, id: { in: all.map((e) => e.id) }, archivedInPeriodId: null }, data: { archivedInPeriodId: period.id } })
    }

    // The first point of the series: the baseline valued at the cutover.
    const v = valueHoldings(held.map((b) => ({ assetId: b.assetId, quantity: b.quantity })), toMarkInputs(marks), platformRate, opts.at)
    await tx.portfolioSnapshot.create({
      data: {
        userId, periodId: period.id, takenAt: opts.at, bucket: minuteBucket(opts.at),
        valuePkr: v.valuePkr, fxUsdtPkr: platformRate, heldCount: v.heldCount, pricedCount: v.pricedCount, staleCount: v.staleCount, trigger: 'cutover',
      },
    })

    return { ...view, status: 'created' as const, periodId: period.id, version }
  }, { timeout: 60_000, maxWait: 15_000 })
}

/** Plain facts about what could not be reconciled. Never an instruction to make up a number. */
function reconcile(a: {
  baseline: BaselineAsset[]
  held: BaselineAsset[]
  assets: Array<{ id: string; name: string; symbol: string | null; network: string | null; contractAddress: string | null; ctmTokenId: string | null }>
  markByAsset: Map<string, MarkRow>
  usdtAssets: ReadonlySet<string>
  custody: Reconciliation['context']
  nameOf: Map<string, string>
}): ReconciliationDiscrepancy[] {
  const out: ReconciliationDiscrepancy[] = []
  const name = (id: string) => a.nameOf.get(id) ?? 'Token'

  for (const b of a.baseline) {
    if (new D(b.oversoldQuantity).gt(0)) {
      out.push({ kind: 'oversold_history', assetId: b.assetId, detail: `${name(b.assetId)}: ${b.oversoldSales} sale(s) were larger than the purchases on record by ${b.oversoldQuantity} in total. The records show nothing held beyond what was bought; no units were added to cover the difference.` })
    }
    if (b.lots.length > 0 && b.basisUnknown) {
      out.push({ kind: 'unknown_cost', assetId: b.assetId, detail: `${name(b.assetId)}: the cost of some units held is not on record, so their profit stays unknown.` })
    }
  }
  for (const b of a.held) {
    if (!a.markByAsset.has(b.assetId)) {
      out.push({ kind: 'unquoted_holding', assetId: b.assetId, detail: `${name(b.assetId)}: no valid price existed on the cutover day, so its opening market value is unknown.` })
    }
  }
  for (const g of findAliasGroups(a.assets.map((x) => ({ ...x })))) {
    out.push({ kind: 'duplicate_identity', detail: `${g.assetIds.map(name).join(', ')} share the same identity (${g.key}). They are tracked separately and were not merged.` })
  }

  // USDT: the tracked holding is analytical and the RupChain wallet is custody; they are never added together.
  // A difference is recorded as a fact for the owner, not corrected.
  const walletOwned = a.custody.wallet.reduce((s, w) => s.plus(w.owned), new D(0))
  const trackedUsdt = a.baseline.filter((b) => a.usdtAssets.has(b.assetId)).reduce((s, b) => s.plus(b.quantity), new D(0))
  if (a.custody.wallet.length > 0 && !walletOwned.minus(trackedUsdt).abs().lt('0.00000001')) {
    out.push({
      kind: 'usdt_wallet_difference',
      detail: `Tracked Tether USDT is ${trackedUsdt.toFixed()} while the RupChain wallet holds ${walletOwned.toFixed()} (the reserved part is inside that figure, not added to it). They are different records and were left as they are.`,
    })
  }
  return out
}

// ── Rollback ───────────────────────────────────────────────────────────────

export interface RollbackResult { status: 'rolled_back' | 'none'; periodId: string | null; entriesRestored: number }

/**
 * Undo the user's active period: its entries become current again, the period is marked rolled back, and the
 * portfolio behaves as before the cutover. Entries recorded after the cutover are untouched. Its snapshots and
 * baseline stay stored (under the inactive period) for audit.
 */
export async function rollbackUser(userId: string): Promise<RollbackResult> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portfolio-restore:${userId}`}))`
    const active = await tx.portfolioTrackingPeriod.findFirst({ where: { userId, status: 'active' }, select: { id: true } })
    if (!active) return { status: 'none' as const, periodId: null, entriesRestored: 0 }
    const res = await tx.portfolioEvent.updateMany({ where: { userId, archivedInPeriodId: active.id }, data: { archivedInPeriodId: null } })
    await tx.portfolioTrackingPeriod.update({ where: { id: active.id }, data: { status: 'rolled_back', rolledBackAt: new Date() } })
    return { status: 'rolled_back' as const, periodId: active.id, entriesRestored: res.count }
  }, { timeout: 60_000, maxWait: 15_000 })
}

/**
 * A user who has never recorded anything starts tracking now: they get their (empty-baseline) period the first
 * time their portfolio is used. A user who already has records is never migrated implicitly: that is the
 * deliberate cutover script, which backs the data up first.
 */
export async function ensurePeriodForNewPortfolio(userId: string, now: Date = new Date()): Promise<PeriodView | null> {
  try {
    const existing = await getActivePeriod(userId)
    if (existing) return existing
    const anyEntries = await db.portfolioEvent.count({ where: { userId } })
    if (anyEntries > 0) return null // an existing portfolio waits for the cutover
    const hadPeriod = await db.portfolioTrackingPeriod.count({ where: { userId } })
    if (hadPeriod > 0) return null // rolled back on purpose: do not silently start a new one
    await cutoverUser(userId, { at: now, reason: 'new_portfolio' })
    return await getActivePeriod(userId)
  } catch (err) {
    logger.warn({ err, userId }, 'portfolio: could not start a tracking period')
    return null
  }
}
