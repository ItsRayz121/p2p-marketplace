import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * Real-database checks for the portfolio tracking-period cutover: opening baseline, archive (nothing deleted),
 * idempotence, late and in-flight entries, rollback, backup and restore, snapshots, new portfolios and isolation
 * between users. Skipped unless TEST_DATABASE_URL is set; refuses any non-local database.
 * See vitest.integration.config.ts.
 */
const url = process.env.TEST_DATABASE_URL
const host = url ? (() => { try { return new URL(url).hostname } catch { return '' } })() : ''
if (url && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to run integration tests against non-local database host "${host}"`)

const h = vi.hoisted(() => ({ client: null as unknown, config: {} as Record<string, string> }))
vi.mock('../../lib/prisma', async () => {
  const { PrismaClient: P } = await import('@prisma/client')
  const client = process.env.TEST_DATABASE_URL ? new P({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }) : (null as never)
  h.client = client
  return { db: client }
})
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test', CNIC_HASH_SECRET: 'integration-test-cnic-0123456789abc' } }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../platformFlags.service', () => ({ getStringConfig: async (k: string, d: string) => h.config[k] ?? d, getBoolConfig: async () => true }))

import { cutoverUser, rollbackUser, getActivePeriod, currentRows, ensurePeriodForNewPortfolio } from '../portfolioPeriod.service'
import { recordSnapshot } from '../portfolioSnapshot.service'
import { dumpPortfolioState, restoreDump, serializeDump, parseDump } from '../portfolioDump.service'
import { buildSummary } from '../../lib/portfolio/summaryBuilder'
import { openingMarketTotal } from '../../lib/portfolio/period'
import { latestMarksForUser } from '../portfolioMarks.service'

describe.skipIf(!url)('portfolio tracking period against a real database', () => {
  const db = () => h.client as PrismaClient
  const tag = Math.random().toString(36).slice(2, 8)
  const users = { a: '', b: '', fresh: '', walletOnly: '' }
  const ids = { ax: '', ay: '', ausdt: '', bx: '' }
  const HOUR = 3600_000
  const AT = new Date(Date.now() - 2 * HOUR)
  let n = 0

  const mkUser = async (k: string) => (await db().user.create({ data: { email: `${k}-${tag}@example.test`, fullName: k, username: `${k}_${tag}`, passwordHash: 'x', isEmailVerified: true } as never })).id
  const ev = (userId: string, assetId: string, type: 'BUY' | 'SELL', quantity: string, consideration: string, at: Date, extra: Record<string, unknown> = {}) =>
    db().portfolioEvent.create({ data: { userId, assetId, type, occurredAt: at, quantity, consideration, fee: '0', quote: 'PKR', source: 'manual', clientRequestId: `c-${tag}-${++n}`, ...extra } })

  beforeAll(async () => {
    h.config = { rate_USDT_PKR: '280', platform_timezone: 'Asia/Karachi' }
    for (const k of ['a', 'b', 'fresh', 'walletOnly'] as const) users[k] = await mkUser(k)
    const mkAsset = async (userId: string, name: string, extra: Record<string, unknown> = {}) => (await db().portfolioAsset.create({ data: { userId, name, ...extra } })).id
    ids.ax = await mkAsset(users.a, 'Token X')
    ids.ay = await mkAsset(users.a, 'Token Y')
    ids.ausdt = await mkAsset(users.a, 'Tether USDT', { symbol: 'USDT', ctmTokenId: 'p2p-usdt' })
    ids.bx = await mkAsset(users.b, 'B Token')

    // A: X bought 10 @ 100 and 10 @ 120, 5 sold @ 130 (FIFO: 150 profit, 15 left costing 1,700).
    await ev(users.a, ids.ax, 'BUY', '10', '1000', new Date('2026-09-01T00:00:00Z'))
    await ev(users.a, ids.ax, 'BUY', '10', '1200', new Date('2026-09-02T00:00:00Z'))
    await ev(users.a, ids.ax, 'SELL', '5', '650', new Date('2026-09-03T00:00:00Z'))
    // A: Y sold more than was ever recorded as bought.
    await ev(users.a, ids.ay, 'BUY', '1', '100', new Date('2026-09-01T00:00:00Z'))
    await ev(users.a, ids.ay, 'SELL', '3', '400', new Date('2026-09-02T00:00:00Z'))
    // A: 100 USDT bought at 280 (so its own PKR/USDT rate is known).
    await ev(users.a, ids.ausdt, 'BUY', '100', '28000', new Date('2026-09-05T00:00:00Z'), { fxRate: '280', fxSource: 'manual' })
    // A: an entry dated AFTER the cutover instant but already recorded when the cutover runs.
    await ev(users.a, ids.ax, 'BUY', '2', '300', new Date(AT.getTime() + HOUR / 2))
    await db().portfolioPriceObservation.create({ data: { userId: users.a, assetId: ids.ax, price: '150', quote: 'PKR', source: 'manual' } })
    // B has its own, unrelated portfolio.
    await ev(users.b, ids.bx, 'BUY', '9', '900', new Date('2026-09-01T00:00:00Z'))

    // Wallet context: A's USDT wallet matches the tracked USDT (100, of which 30 is reserved); the other user has wallet-only USDT.
    await db().wallet.create({ data: { userId: users.a, coin: 'USDT', network: 'TRC20', balance: '100', lockedBalance: '30' } })
    await db().wallet.create({ data: { userId: users.walletOnly, coin: 'USDT', network: 'TRC20', balance: '50', lockedBalance: '0' } })
  })

  afterAll(async () => {
    const all = Object.values(users)
    await db().portfolioSnapshot.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioOpeningHolding.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioTrackingPeriod.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioPriceObservation.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioEventRevision.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioEvent.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioAsset.deleteMany({ where: { userId: { in: all } } })
    await db().wallet.deleteMany({ where: { userId: { in: all } } })
    await db().user.deleteMany({ where: { id: { in: all } } })
    await db().$disconnect()
  })

  const countEvents = (userId: string, archived?: boolean) =>
    db().portfolioEvent.count({ where: { userId, ...(archived === undefined ? {} : archived ? { archivedInPeriodId: { not: null } } : { archivedInPeriodId: null }) } })

  const summaryNow = async (userId: string, currency: 'PKR' | 'USDT' = 'PKR') => {
    const period = await getActivePeriod(userId)
    const events = await db().portfolioEvent.findMany({ where: { userId, voidedAt: null, archivedInPeriodId: null }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] })
    const usdt = new Set((await db().portfolioAsset.findMany({ where: { userId, ctmTokenId: 'p2p-usdt' } })).map((a) => a.id))
    const rows = currentRows({ events, period, currency, platformRate: '280', usdtAssets: usdt })
    return { period, summary: buildSummary({ events: rows, prices: await latestMarksForUser(userId), currency, platformRate: '280' }) }
  }

  it('a dry run reports the baseline and writes nothing', async () => {
    const before = await countEvents(users.a)
    const r = await cutoverUser(users.a, { at: AT, dryRun: true })
    expect(r.status).toBe('dry_run')
    expect(r.assetsInBaseline).toBe(2) // X and USDT; Y has nothing left
    expect(r.entriesArchived).toBe(before - 1) // the entry dated after the cutover is not part of it
    expect(await db().portfolioTrackingPeriod.count({ where: { userId: users.a } })).toBe(0)
    expect(await countEvents(users.a, true)).toBe(0)
  })

  it('creates the opening baseline: actual cost kept, quote recorded separately, nothing deleted', async () => {
    const total = await countEvents(users.a)
    const r = await cutoverUser(users.a, { at: AT })
    expect(r).toMatchObject({ status: 'created', version: 1, timezone: 'Asia/Karachi' })

    expect(await countEvents(users.a)).toBe(total) // nothing deleted
    expect(await countEvents(users.a, true)).toBe(total - 1) // everything dated up to the cutover is archived
    expect(await countEvents(users.a, false)).toBe(1) // the entry dated after it stays current

    const period = (await getActivePeriod(users.a))!
    expect(period.startedAt.getTime()).toBe(AT.getTime())
    expect(period.fxUsdtPkr).toBe('280')
    const x = period.holdings.find((hh) => hh.assetId === ids.ax)!
    expect(x.quantity).toBe('15')
    expect((x.lots as Array<{ qty: string; basisPkr: string }>).map((l) => [l.qty, l.basisPkr])).toEqual([['5', '500'], ['10', '1200']])
    expect(x.market).toMatchObject({ price: '150', quote: 'PKR', source: 'manual' }) // the quote is stored apart from the cost
    expect(period.holdings.find((hh) => hh.assetId === ids.ausdt)!.quantity).toBe('100')
    expect(period.holdings.find((hh) => hh.assetId === ids.ay)).toBeUndefined() // nothing invented for the oversold token

    const rec = period.reconciliation as { discrepancies: Array<{ kind: string }>; context: { wallet: Array<{ owned: string; reserved: string; available: string }> } }
    expect(rec.discrepancies.map((d) => d.kind)).toContain('oversold_history')
    // The wallet's reserved amount is part of what it owns; it is context, never added to a holding.
    expect(rec.context.wallet).toEqual([{ coin: 'USDT', network: 'TRC20', owned: '100', reserved: '30', available: '70' }])
    expect(rec.discrepancies.map((d) => d.kind)).not.toContain('usdt_wallet_difference') // tracked 100 = wallet 100
  })

  it('is idempotent: running it again changes nothing and duplicates no holdings', async () => {
    const holdings = await db().portfolioOpeningHolding.count({ where: { userId: users.a } })
    const r = await cutoverUser(users.a, { at: new Date(AT.getTime() + 60_000) })
    expect(r.status).toBe('exists')
    expect(await db().portfolioOpeningHolding.count({ where: { userId: users.a } })).toBe(holdings)
    expect(await db().portfolioTrackingPeriod.count({ where: { userId: users.a } })).toBe(1)
    expect((await Promise.all([1, 2, 3].map(() => cutoverUser(users.a, { at: AT })))).every((x) => x.status === 'exists')).toBe(true)
  })

  it('the current summary continues from the baseline: same holdings, actual cost, no old warnings', async () => {
    const { summary } = await summaryNow(users.a)
    const x = summary.summary.positions.find((p) => p.assetId === ids.ax)!
    expect(x.quantity).toBe('17') // 15 at the cutover + the 2 bought just after
    expect(x.knownRemainingBasis).toBe('2000') // 1,700 baseline + 300
    expect(x.realizedKnown).toBe('0') // earlier sales belong to the archive
    expect(summary.summary.unresolvedAssets).toEqual([]) // the oversold history is archived, not a current warning
    expect(summary.summary.positions.find((p) => p.assetId === ids.ay)).toBeUndefined()
    const usdt = summary.summary.positions.find((p) => p.assetId === ids.ausdt)!
    expect(usdt.quantity).toBe('100')
    expect(usdt.value).toBe('28000') // 100 USDT x 280
  })

  it('USD-style and USDT holdings coexist, and the display currency changes no quantity', async () => {
    const pkr = (await summaryNow(users.a, 'PKR')).summary.summary.positions
    const usdt = (await summaryNow(users.a, 'USDT')).summary.summary.positions
    expect(usdt.map((p) => [p.assetId, p.quantity])).toEqual(pkr.map((p) => [p.assetId, p.quantity]))
    expect(usdt.find((p) => p.assetId === ids.ausdt)!.value).toBe('100')
  })

  it('a late entry (dated before the cutover, recorded after) counts from the cutover; an archived one is not double counted', async () => {
    await ev(users.a, ids.ax, 'SELL', '2', '400', new Date(AT.getTime() - 24 * HOUR))
    const { summary } = await summaryNow(users.a)
    const x = summary.summary.positions.find((p) => p.assetId === ids.ax)!
    expect(x.quantity).toBe('15') // 17 - 2: counted once
    expect(x.realizedKnown).toBe('200') // 400 - 2 x 100 (oldest baseline lot)
    expect(await countEvents(users.a, true)).toBe((await db().portfolioEvent.count({ where: { userId: users.a, archivedInPeriodId: { not: null } } })))
  })

  it("does not touch another user's portfolio", async () => {
    expect(await countEvents(users.b, true)).toBe(0)
    expect(await db().portfolioTrackingPeriod.count({ where: { userId: users.b } })).toBe(0)
    const rb = await cutoverUser(users.b, { at: AT })
    expect(rb.assetsInBaseline).toBe(1)
    const a = (await getActivePeriod(users.a))!
    const b = (await getActivePeriod(users.b))!
    expect(a.holdings.every((hh) => hh.assetId !== ids.bx)).toBe(true)
    expect(b.holdings.map((hh) => hh.assetId)).toEqual([ids.bx])
    expect(a.id).not.toBe(b.id)
  })

  it('stores snapshots: one value per minute, gaps stay null, views are throttled', async () => {
    expect(await recordSnapshot(users.a, 'event')).toBe('recorded')
    expect(await recordSnapshot(users.a, 'event')).toBe('recorded') // same minute: replaces, never duplicates
    expect(await recordSnapshot(users.a, 'view')).toBe('skipped') // a point exists from a moment ago
    const period = (await getActivePeriod(users.a))!
    const snaps = await db().portfolioSnapshot.findMany({ where: { periodId: period.id }, orderBy: { takenAt: 'asc' } })
    expect(snaps.length).toBe(2) // the cutover point + this minute
    expect(snaps[0]!.trigger).toBe('cutover')
    // X priced at 150 (15 units) and USDT at 1 USDT = 280: 15 x 150 + 100 x 280 = 30,250.
    expect(snaps[1]!.valuePkr!.toFixed()).toBe('30250')
    expect(snaps[1]).toMatchObject({ heldCount: 2, pricedCount: 2 })

    // A held token without any quote makes the point a gap, not a partial sum.
    const yId = (await db().portfolioAsset.create({ data: { userId: users.a, name: 'No price' } })).id
    await ev(users.a, yId, 'BUY', '1', '10', new Date())
    await db().portfolioSnapshot.deleteMany({ where: { periodId: period.id, trigger: 'event' } })
    expect(await recordSnapshot(users.a, 'event')).toBe('recorded')
    const gap = await db().portfolioSnapshot.findFirst({ where: { periodId: period.id, trigger: 'event' } })
    expect(gap!.valuePkr).toBeNull()
    expect(gap).toMatchObject({ heldCount: 3, pricedCount: 2 })
    await db().portfolioEvent.deleteMany({ where: { assetId: yId } })
    await db().portfolioAsset.delete({ where: { id: yId } })
  })

  it('the opening market value is the baseline valued at the cutover quotes, separate from cost', async () => {
    const period = (await getActivePeriod(users.a))!
    const v = openingMarketTotal(period.holdings.map((hh) => ({ quantity: hh.quantity, market: hh.market })), 'PKR', period.fxUsdtPkr)
    expect(v).toBe('30250')
    expect(openingMarketTotal(period.holdings.map((hh) => ({ quantity: hh.quantity, market: hh.market })), 'USDT', period.fxUsdtPkr)).toBe('108.03571435')
  })

  it('a rollback makes the archived entries current again; the baseline and snapshots stay for audit', async () => {
    const r = await rollbackUser(users.a)
    expect(r.status).toBe('rolled_back')
    expect(await countEvents(users.a, true)).toBe(0)
    expect(await getActivePeriod(users.a)).toBeNull()
    expect(await db().portfolioTrackingPeriod.findMany({ where: { userId: users.a } })).toHaveLength(1)
    expect(await rollbackUser(users.a)).toMatchObject({ status: 'none' })
    // A rolled-back user is not silently moved onto a new period; the cutover can be run again on purpose (version 2).
    expect(await ensurePeriodForNewPortfolio(users.a)).toBeNull()
    const again = await cutoverUser(users.a, { at: AT })
    expect(again).toMatchObject({ status: 'created', version: 2 })
    const { summary } = await summaryNow(users.a)
    expect(summary.summary.positions.find((p) => p.assetId === ids.ax)!.quantity).toBe('15')
  })

  it('backup and restore: every row comes back, nothing is duplicated, and a second restore adds nothing', async () => {
    const dump = await dumpPortfolioState([users.a, users.b])
    const { text, sha256 } = serializeDump(dump)
    expect(() => parseDump(text.replace('Token X', 'Token Z'), sha256)).toThrow(/checksum/)
    const parsed = parseDump(text, sha256)
    expect(parsed.counts.events).toBeGreaterThan(5)

    // Simulate losing user A's portfolio rows entirely.
    const all = [users.a]
    await db().portfolioSnapshot.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioOpeningHolding.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioTrackingPeriod.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioPriceObservation.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioEvent.deleteMany({ where: { userId: { in: all } } })
    await db().portfolioAsset.deleteMany({ where: { userId: { in: all } } })
    expect((await dumpPortfolioState([users.a])).counts.events).toBe(0)

    const res = await restoreDump(parsed)
    expect(res.created.events).toBeGreaterThan(0)
    const after = await dumpPortfolioState([users.a, users.b])
    expect(after.counts).toEqual(parsed.counts)
    // Exact values survive the round trip (decimals as strings, dates as instants).
    expect(after.tables.events).toEqual(parsed.tables.events)
    expect(after.tables.holdings).toEqual(parsed.tables.holdings)

    const second = await restoreDump(parsed)
    expect(Object.values(second.created).every((c) => c === 0)).toBe(true)
  })

  it('a new portfolio starts tracking on first use; an existing one waits for the cutover', async () => {
    const p = await ensurePeriodForNewPortfolio(users.fresh)
    expect(p).toMatchObject({ version: 1, reason: 'new_portfolio' })
    expect(p!.holdings).toEqual([])
    expect((await ensurePeriodForNewPortfolio(users.fresh))!.id).toBe(p!.id) // idempotent

    await db().portfolioTrackingPeriod.deleteMany({ where: { userId: users.b } }) // B has entries but (here) no period
    await db().portfolioEvent.updateMany({ where: { userId: users.b }, data: { archivedInPeriodId: null } })
    expect(await ensurePeriodForNewPortfolio(users.b)).toBeNull()
  })

  it('records a USDT wallet that differs from the tracked holding as a fact, without changing either', async () => {
    const r = await cutoverUser(users.walletOnly, { at: AT })
    expect(r.status).toBe('created')
    expect(r.discrepancies.map((d) => d.kind)).toEqual(['usdt_wallet_difference'])
    expect(r.assetsInBaseline).toBe(0)
  })
})
