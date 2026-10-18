import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { cleanRate } from '../lib/portfolio/currency'
import { buildSummary } from '../lib/portfolio/summaryBuilder'
import { minuteBucket, valueHoldings, type MarkInput } from '../lib/portfolio/snapshot'
import { USDT_ASSET_KEY } from '../lib/portfolio/usdtImport'
import { getStringConfig } from './platformFlags.service'
import { latestMarksForUser } from './portfolioMarks.service'
import { currentRows, getActivePeriod } from './portfolioPeriod.service'

/**
 * Stored observations of the portfolio's value (the chart's series). Taken on a schedule, after changes to the
 * entries, and when the portfolio is viewed after a long quiet spell. Each point values the holdings with the
 * best quote available at that moment; a token with no usable quote makes the point a gap (null), never a zero
 * or a partial total. Analytical tables only.
 */

export type SnapshotTrigger = 'schedule' | 'event' | 'view'
export type SnapshotOutcome = 'recorded' | 'no_period' | 'skipped'

/** A view only adds a point when the newest one is older than this. */
export const VIEW_MIN_INTERVAL_MS = 30 * 60 * 1000

const EVENT_FIELDS = {
  id: true, assetId: true, type: true, occurredAt: true, quantity: true, consideration: true, fee: true, basis: true,
  zeroCost: true, quote: true, fxRate: true, source: true,
} as const

export async function recordSnapshot(userId: string, trigger: SnapshotTrigger, now: Date = new Date()): Promise<SnapshotOutcome> {
  const period = await getActivePeriod(userId)
  if (!period) return 'no_period'

  const last = await db.portfolioSnapshot.findFirst({ where: { periodId: period.id }, orderBy: { takenAt: 'desc' }, select: { takenAt: true, heldCount: true } })
  if (trigger === 'view' && last && now.getTime() - last.takenAt.getTime() < VIEW_MIN_INTERVAL_MS) return 'skipped'

  const [events, usdtRows, rateRaw, marks] = await Promise.all([
    db.portfolioEvent.findMany({ where: { userId, voidedAt: null, archivedInPeriodId: null }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], select: EVENT_FIELDS }),
    db.portfolioAsset.findMany({ where: { userId, ctmTokenId: USDT_ASSET_KEY }, select: { id: true } }),
    getStringConfig('rate_USDT_PKR', '').catch(() => ''),
    latestMarksForUser(userId),
  ])
  const rate = cleanRate(rateRaw)
  const rows = currentRows({ events, period, currency: 'PKR', platformRate: rate, usdtAssets: new Set(usdtRows.map((a) => a.id)) })
  const summary = buildSummary({ events: rows, prices: marks, currency: 'PKR', platformRate: rate, now })
  const markInputs = new Map<string, MarkInput>(marks.map((m) => [m.assetId, { price: m.price, quote: m.quote, observedAt: m.observedAt }]))
  const v = valueHoldings(summary.summary.positions.map((p) => ({ assetId: p.assetId, quantity: p.quantity })), markInputs, rate, now)

  // A quiet account that holds nothing and held nothing last time gains no information from another point.
  if (trigger === 'schedule' && v.heldCount === 0 && last && last.heldCount === 0) return 'skipped'

  const data = { takenAt: now, valuePkr: v.valuePkr, fxUsdtPkr: rate, heldCount: v.heldCount, pricedCount: v.pricedCount, staleCount: v.staleCount, trigger }
  await db.portfolioSnapshot.upsert({
    where: { periodId_bucket: { periodId: period.id, bucket: minuteBucket(now) } },
    create: { userId, periodId: period.id, bucket: minuteBucket(now), ...data },
    update: data,
  })
  return 'recorded'
}

/** Fire-and-forget after a change: a failed snapshot must never fail the change that triggered it. */
export function snapshotSoon(userId: string, trigger: SnapshotTrigger): void {
  void recordSnapshot(userId, trigger).catch((err) => logger.warn({ err, userId, trigger }, 'portfolio snapshot failed'))
}

/** Scheduled run: one point for every user with an active period. Bounded work, one user at a time. */
export async function runPortfolioSnapshots(): Promise<{ users: number; recorded: number; failed: number }> {
  let users = 0, recorded = 0, failed = 0
  let cursor: string | undefined
  for (;;) {
    const page = await db.portfolioTrackingPeriod.findMany({
      where: { status: 'active' }, orderBy: { id: 'asc' }, take: 200, select: { id: true, userId: true },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (page.length === 0) break
    cursor = page[page.length - 1]!.id
    for (const p of page) {
      users += 1
      try { if ((await recordSnapshot(p.userId, 'schedule')) === 'recorded') recorded += 1 } catch (err) { failed += 1; logger.warn({ err, userId: p.userId }, 'portfolio scheduled snapshot failed') }
    }
  }
  return { users, recorded, failed }
}
