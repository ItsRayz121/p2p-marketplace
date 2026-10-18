import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  period: vi.fn(), ensure: vi.fn(),
  evFindMany: vi.fn(), evFindFirst: vi.fn(), evCount: vi.fn(), evDeleteMany: vi.fn(), evUpdateMany: vi.fn(),
  assetFindFirst: vi.fn(), assetFindMany: vi.fn(),
  prFindMany: vi.fn(), snapFindMany: vi.fn(), cfg: vi.fn(), snapSoon: vi.fn(),
}))

vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findFirst: m.assetFindFirst, findMany: m.assetFindMany },
    portfolioEvent: { findMany: m.evFindMany, findFirst: m.evFindFirst, count: m.evCount, deleteMany: m.evDeleteMany, updateMany: m.evUpdateMany },
    portfolioPriceObservation: { findMany: m.prFindMany },
    portfolioSnapshot: { findMany: m.snapFindMany },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ portfolioEvent: { deleteMany: m.evDeleteMany, updateMany: m.evUpdateMany }, portfolioEventRevision: { create: vi.fn() } }),
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.cfg, getBoolConfig: async () => true }))
vi.mock('../../services/portfolioMarks.service', async (orig) => ({ ...(await orig<typeof import('../../services/portfolioMarks.service')>()), platformMarksFor: async (links: Array<{ id: string; ctmTokenId: string | null }>) => links.filter((l) => l.ctmTokenId === 'p2p-usdt').map((l) => ({ assetId: l.id, price: '1', quote: 'USDT' as const, observedAt: new Date(), source: 'platform' })), platformHistoryFor: async () => [], logosFor: async () => new Map() }))
vi.mock('../../services/portfolioPeriod.service', async (orig) => ({ ...(await orig<typeof import('../../services/portfolioPeriod.service')>()), getActivePeriod: m.period, ensurePeriodForNewPortfolio: m.ensure }))
vi.mock('../../services/portfolioSnapshot.service', () => ({ snapshotSoon: m.snapSoon, recordSnapshot: vi.fn() }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: async (req: { headers: Record<string, string | undefined>; user?: { id: string } }) => {
    const id = req.headers['x-test-user']
    if (!id) { const { AppError } = await import('../../lib/errors'); throw new AppError('UNAUTHORIZED', 'Authentication required', 401) }
    req.user = { id }
  },
}))

import { portfolioRoutes } from '../portfolio.routes'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const U = { 'x-test-user': 'u1' }
const dec = (s: string) => new Prisma.Decimal(s)
const STARTED = new Date(Date.now() - 3 * 3600_000) // tracking began three hours ago

const lot = (qty: string, basisPkr: string | null) => ({ eventId: 'old', acquiredAt: '2026-09-01T00:00:00Z', qty, basisPkr, basisUsdt: null })
const PERIOD = (o: Record<string, unknown> = {}) => ({
  id: 'p1', version: 1, reason: 'cutover', startedAt: STARTED, timezone: 'Asia/Karachi', fxUsdtPkr: '280', fxSource: 'platform', reconciliation: { discrepancies: [{ kind: 'oversold_history', detail: 'MEC sold more than recorded.' }] },
  holdings: [
    { id: 'h1', assetId: 'a1', quantity: '15', lots: [lot('5', '500'), lot('10', '1200')], market: { price: '150', quote: 'PKR', source: 'manual', observedAt: STARTED } },
    { id: 'h2', assetId: 'a2', quantity: '100', lots: [{ eventId: 'u', acquiredAt: '2026-09-01T00:00:00Z', qty: '100', basisPkr: '28000', basisUsdt: '100' }], market: { price: '1', quote: 'USDT', source: 'platform', observedAt: STARTED } },
  ],
  ...o,
})
const evRow = (o: Record<string, unknown> = {}) => ({
  id: 'ev1', assetId: 'a1', type: 'BUY', occurredAt: new Date(), quantity: dec('2'), consideration: dec('300'), fee: dec('0'), basis: null, zeroCost: false,
  quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(), source: 'manual', voidedAt: null, voidReason: null, archivedInPeriodId: null, ...o,
})

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.cfg.mockResolvedValue('280')
  m.period.mockResolvedValue(PERIOD())
  m.ensure.mockResolvedValue(null)
  m.evFindMany.mockResolvedValue([])
  m.evCount.mockResolvedValue(0)
  m.assetFindMany.mockResolvedValue([{ id: 'a2', ctmTokenId: 'p2p-usdt', archivedAt: null }])
  m.assetFindFirst.mockResolvedValue({ id: 'a1', archivedAt: null })
  m.prFindMany.mockResolvedValue([{ assetId: 'a1', price: dec('150'), quote: 'PKR', observedAt: new Date(), source: 'manual' }])
  m.snapFindMany.mockResolvedValue([])
})

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: U })

describe('summary in a tracking period', () => {
  it('continues from the baseline with its ACTUAL cost, counts positive balances once, and reports the period', async () => {
    const res = (await get('/portfolio/summary?currency=PKR')).json().data
    const x = res.summary.positions.find((p: { assetId: string }) => p.assetId === 'a1')
    expect(x).toMatchObject({ quantity: '15', knownRemainingBasis: '1700', value: '2250', unrealized: '550' })
    expect(res.summary.positions.find((p: { assetId: string }) => p.assetId === 'a2')).toMatchObject({ quantity: '100', value: '28000' })
    expect(res.assetsHeld).toBe(2)
    expect(res.tracking).toMatchObject({ version: 1, timezone: 'Asia/Karachi', startedToday: expect.any(Boolean) })
    expect(res.tracking.openingMarketValue).toBe('30250') // 15 x 150 + 100 USDT at 280
    expect(res.summary.unresolvedAssets).toEqual([]) // earlier oversold history is archived, not a current warning
    expect(res.summary.positions[0]).not.toHaveProperty('lots') // internal detail never leaves the server
  })
  it('only reads entries of the current period', async () => {
    await get('/portfolio/summary')
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', voidedAt: null, archivedInPeriodId: null })
  })
  it('PKR and USDT show the same quantities and the same count', async () => {
    const pkr = (await get('/portfolio/summary?currency=PKR')).json().data
    const usdt = (await get('/portfolio/summary?currency=USDT')).json().data
    const q = (d: { summary: { positions: Array<{ assetId: string; quantity: string }> } }) => d.summary.positions.map((p) => [p.assetId, p.quantity])
    expect(q(usdt)).toEqual(q(pkr))
    expect(usdt.assetsHeld).toBe(pkr.assetsHeld)
    expect(usdt.summary.positions.find((p: { assetId: string }) => p.assetId === 'a2').value).toBe('100') // USDT is USDT, not USD
  })
  it('a token with nothing left is not counted as held; archived tokens are not counted either', async () => {
    m.period.mockResolvedValue(PERIOD({ holdings: [] }))
    m.evFindMany.mockResolvedValue([
      evRow({ id: 'b', type: 'BUY', quantity: dec('2'), consideration: dec('200') }),
      evRow({ id: 's', type: 'SELL', occurredAt: new Date(Date.now() + 1000), quantity: dec('2'), consideration: dec('250') }),
      evRow({ id: 'c', assetId: 'a3', quantity: dec('4'), consideration: dec('40') }),
    ])
    m.assetFindMany.mockResolvedValue([{ id: 'a3', ctmTokenId: null, archivedAt: new Date() }])
    const res = (await get('/portfolio/summary')).json().data
    expect(res.assetsHeld).toBe(0)
  })
  it('a view schedules a snapshot after replying; a user without a period gets none', async () => {
    await get('/portfolio/summary')
    expect(m.snapSoon).toHaveBeenCalledWith('u1', 'view')
    m.snapSoon.mockReset(); m.period.mockResolvedValue(null)
    const res = (await get('/portfolio/summary')).json().data
    expect(m.snapSoon).not.toHaveBeenCalled()
    expect(res.tracking).toBeNull()
  })
})

describe('performance in a tracking period', () => {
  const snap = (iso: string, valuePkr: string | null) => ({ takenAt: new Date(iso), valuePkr: valuePkr === null ? null : dec(valuePkr), fxUsdtPkr: dec('280'), heldCount: 2, pricedCount: valuePkr === null ? 1 : 2 })

  it('starts at the baseline, uses stored points plus the live one, and reconciles with the summary', async () => {
    m.snapFindMany.mockResolvedValue([snap(STARTED.toISOString(), '30250')])
    const p = (await get('/portfolio/performance?currency=PKR&from=2020-01-01T00:00:00Z')).json().data
    expect(p.from).toBe(STARTED.toISOString()) // an earlier range is clamped to the start of tracking
    expect(p.points).toHaveLength(2)
    expect(p.points[0]).toMatchObject({ t: STARTED.toISOString(), value: '30250' })
    const summary = (await get('/portfolio/summary?currency=PKR')).json().data
    expect(p.points.at(-1).value).toBe(summary.summary.pricedValue) // the latest point is the headline value
    expect(p.tracking).toMatchObject({ version: 1, observations: 2, openingMarketValue: '30250' })
    expect(p.period.valueStart).toBe('30250')
  })
  it('a single observation is one point; nothing is drawn before the cutover', async () => {
    const p = (await get('/portfolio/performance')).json().data
    expect(p.points).toHaveLength(1)
    expect(new Date(p.points[0].t).getTime()).toBeGreaterThanOrEqual(STARTED.getTime())
  })
  it('USDT shows stored points at the rate of their own moment', async () => {
    m.snapFindMany.mockResolvedValue([snap(STARTED.toISOString(), '28000')])
    const p = (await get('/portfolio/performance?currency=USDT')).json().data
    expect(p.points[0].value).toBe('100')
    expect(p.currency).toBe('USDT')
  })
  it('a gap in the stored points stays a gap', async () => {
    m.snapFindMany.mockResolvedValue([snap(STARTED.toISOString(), '30250'), snap(new Date(STARTED.getTime() + 3600_000).toISOString(), null)])
    const p = (await get('/portfolio/performance')).json().data
    expect(p.points.map((x: { value: string | null }) => x.value === null)).toEqual([false, true, false])
  })
  it('rejects an inverted range', async () => {
    const res = await get('/portfolio/performance?from=2026-10-18T09:00:00Z&to=2026-10-18T08:00:00Z')
    expect(res.statusCode).toBe(400)
  })
})

describe('entries in a tracking period', () => {
  it("a token's history starts with the read-only opening holdings line, carrying the actual cost", async () => {
    m.evFindMany.mockResolvedValue([evRow()])
    const items = (await get('/portfolio/assets/a1/events')).json().data
    expect(items[0]).toMatchObject({ id: 'open:h1', type: 'OPENING', source: 'baseline', quantity: '15', basis: '1700', archived: false })
    expect(items[1]).toMatchObject({ id: 'ev1', archived: false })
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', assetId: 'a1', archivedInPeriodId: null })
  })
  it('an unknown cost in the baseline stays unknown in that line', async () => {
    m.period.mockResolvedValue(PERIOD({ holdings: [{ id: 'h1', assetId: 'a1', quantity: '5', lots: [lot('5', null)], market: { price: null, quote: null, source: null, observedAt: null } }] }))
    const items = (await get('/portfolio/assets/a1/events')).json().data
    expect(items[0]).toMatchObject({ basis: null, zeroCost: false })
  })
  it('scope=archived lists the earlier entries, flagged, without the opening line', async () => {
    m.evFindMany.mockResolvedValue([evRow({ id: 'old', archivedInPeriodId: 'p1' })])
    const items = (await get('/portfolio/assets/a1/events?scope=archived')).json().data
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'old', archived: true })
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', assetId: 'a1', archivedInPeriodId: { not: null } })
  })
  it('rejects an unknown scope', async () => {
    expect((await get('/portfolio/assets/a1/events?scope=everything')).statusCode).toBe(400)
  })
  it('an archived entry cannot be removed or corrected: it is kept as it was', async () => {
    m.evFindFirst.mockResolvedValue(evRow({ archivedInPeriodId: 'p1' }))
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/portfolio/assets/a1/events/ev1', headers: U })
    expect(del.statusCode).toBe(409)
    expect(del.json().error.message).toMatch(/archived history/)
    const patch = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1/events/ev1', headers: U, payload: { type: 'BUY', occurredAt: '2026-01-01T00:00:00Z', quantity: '1', consideration: '1' } })
    expect(patch.statusCode).toBe(409)
    expect(m.evDeleteMany).not.toHaveBeenCalled()
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })
  it('removing a current entry asks for a fresh snapshot', async () => {
    m.evFindFirst.mockResolvedValue(evRow())
    m.evDeleteMany.mockResolvedValue({ count: 1 })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/portfolio/assets/a1/events/ev1', headers: U })).statusCode).toBe(200)
    expect(m.snapSoon).toHaveBeenCalledWith('u1', 'event')
  })
})

describe('archive', () => {
  it('says there is no period when tracking has not started', async () => {
    m.period.mockResolvedValue(null)
    expect((await get('/portfolio/archive')).json().data).toEqual({ period: null })
  })
  it('reports what was reconciled and the earlier results as partial', async () => {
    m.evFindMany.mockResolvedValue([
      evRow({ id: 'b', type: 'BUY', quantity: dec('1'), consideration: dec('100'), occurredAt: new Date('2026-09-01') }),
      evRow({ id: 's', type: 'SELL', quantity: dec('3'), consideration: dec('400'), occurredAt: new Date('2026-09-02') }),
    ])
    m.evCount.mockResolvedValue(2)
    const d = (await get('/portfolio/archive')).json().data
    expect(d.period).toMatchObject({ version: 1, timezone: 'Asia/Karachi' })
    expect(d.archivedEntries).toBe(2)
    expect(d.discrepancies).toEqual([{ kind: 'oversold_history', detail: 'MEC sold more than recorded.' }])
    expect(d.lifetime).toMatchObject({ sales: 1, salesWithUnknownResult: 1, partial: true })
  })
})
