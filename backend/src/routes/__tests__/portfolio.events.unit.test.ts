import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  evFindMany: vi.fn(), evFindFirst: vi.fn(), evCount: vi.fn(), evCreate: vi.fn(), evDeleteMany: vi.fn(), revCreate: vi.fn(),
  prCreate: vi.fn(), prFindMany: vi.fn(), prCount: vi.fn(), cfg: vi.fn(),
}))

// Only portfolio tables exist on this mock; touching anything else (wallets, transactions, trades,
// orders) throws, which proves these routes cannot affect balances or settlement.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findFirst: m.assetFindFirst, findMany: async () => [], count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    portfolioEvent: { findMany: m.evFindMany, findFirst: m.evFindFirst, count: m.evCount, create: m.evCreate, deleteMany: m.evDeleteMany },
    portfolioEventRevision: { create: m.revCreate },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ portfolioEvent: { deleteMany: m.evDeleteMany }, portfolioEventRevision: { create: m.revCreate } }),
    portfolioPriceObservation: { create: m.prCreate, findMany: m.prFindMany, count: m.prCount },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.cfg, getBoolConfig: async () => true }))
// The only platform data the tracker reads is a token's latest settled trade price and logo (read-only); covered in portfolioMarks tests.
vi.mock('../../services/portfolioMarks.service', async (orig) => ({ ...(await orig<typeof import('../../services/portfolioMarks.service')>()), platformMarksFor: async () => [], platformHistoryFor: async () => [], logosFor: async () => new Map() }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: async (req: { headers: Record<string, string | undefined>; user?: { id: string } }) => {
    const id = req.headers['x-test-user']
    if (!id) { const { AppError } = await import('../../lib/errors'); throw new AppError('UNAUTHORIZED', 'Authentication required', 401) }
    req.user = { id }
  },
}))

import { portfolioRoutes, MAX_PORTFOLIO_EVENTS } from '../portfolio.routes'
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
const NOW = new Date().toISOString()
const past = '2026-01-02T00:00:00.000Z'

const evRow = (o: Record<string, unknown> = {}) => ({
  id: 'ev1', assetId: 'a1', type: 'BUY', occurredAt: new Date(past), quantity: dec('100'), consideration: dec('100000'),
  fee: dec('1000'), basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(past),
  source: 'manual', voidedAt: null, voidReason: null, ...o,
})
const post = (payload: unknown, id = 'a1', headers: Record<string, string> = U) =>
  app.inject({ method: 'POST', url: `/api/v1/portfolio/assets/${id}/events`, headers, payload: payload as object })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.assetFindFirst.mockResolvedValue({ id: 'a1' })
  m.evCount.mockResolvedValue(0)
  m.evFindFirst.mockResolvedValue(null)
  m.cfg.mockResolvedValue('')
  m.prCount.mockResolvedValue(0)
})

describe('auth and ownership', () => {
  it('requires authentication', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/portfolio/assets/a1/events'], ['POST', '/api/v1/portfolio/assets/a1/events'],
      ['DELETE', '/api/v1/portfolio/assets/a1/events/e1'], ['POST', '/api/v1/portfolio/assets/a1/price'],
      ['GET', '/api/v1/portfolio/summary'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401)
    }
  })
  it("another user's asset is a 404 for list, record and price, and nothing is written", async () => {
    m.assetFindFirst.mockResolvedValue(null)
    expect((await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/theirs/events', headers: U })).statusCode).toBe(404)
    expect((await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10' }, 'theirs')).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/theirs/price', headers: U, payload: { price: '5' } })).statusCode).toBe(404)
    expect(m.evCreate).not.toHaveBeenCalled()
    expect(m.prCreate).not.toHaveBeenCalled()
    expect(m.assetFindFirst.mock.calls[0]![0].where).toEqual({ id: 'theirs', userId: 'u1' })
  })
  it('delete is scoped to the caller, the asset and the entry', async () => {
    m.evFindFirst.mockResolvedValue(null)
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/portfolio/assets/a1/events/ev9', headers: U })).statusCode).toBe(404)
    expect(m.evFindFirst.mock.calls[0]![0].where).toEqual({ id: 'ev9', assetId: 'a1', userId: 'u1' })
    expect(m.evDeleteMany).not.toHaveBeenCalled()
    m.evFindFirst.mockResolvedValue(evRow())
    m.evDeleteMany.mockResolvedValue({ count: 1 })
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/portfolio/assets/a1/events/ev1', headers: U })).statusCode).toBe(200)
    expect(m.evDeleteMany.mock.calls[0]![0].where).toEqual({ id: 'ev1', assetId: 'a1', userId: 'u1', source: 'manual' })
    // The removed entry is kept in its history.
    expect(m.revCreate.mock.calls[0]![0].data).toMatchObject({ userId: 'u1', eventId: 'ev1', assetId: 'a1', action: 'delete', before: { type: 'BUY', quantity: '100', consideration: '100000' } })
  })
  it('an entry imported from a RupChain trade is read-only: it cannot be removed', async () => {
    m.evFindFirst.mockResolvedValue({ id: 'ev1', source: 'ctm' })
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/portfolio/assets/a1/events/ev1', headers: U })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toMatch(/read-only/)
    expect(m.evDeleteMany).not.toHaveBeenCalled()
  })
  it('shows where an entry came from and whether it is voided, never the owner', async () => {
    m.evFindMany.mockResolvedValue([evRow({ source: 'ctm', voidedAt: new Date(), voidReason: 'disputed' })])
    const e = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/a1/events', headers: U })).json().data[0]
    expect(e).toMatchObject({ source: 'ctm', voided: true, voidReason: 'disputed' })
    expect(e).not.toHaveProperty('userId')
    expect(e).not.toHaveProperty('sourceRef')
  })
  it('never returns the owner id and sends decimals as strings, with no-store', async () => {
    m.evFindMany.mockResolvedValue([evRow()])
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/a1/events', headers: U })
    const e = res.json().data[0]
    expect(e).not.toHaveProperty('userId')
    expect(e.quantity).toBe('100')
    expect(typeof e.consideration).toBe('string')
    expect(res.headers['cache-control']).toBe('private, no-store')
  })
})

describe('recording', () => {
  it('stores a BUY with exact decimal strings, owned by the caller, fee defaulting to 0', async () => {
    m.evCreate.mockResolvedValue(evRow())
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '100', consideration: '100000' })
    expect(res.statusCode).toBe(201)
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({
      userId: 'u1', assetId: 'a1', type: 'BUY', quantity: '100', consideration: '100000', fee: '0', basis: null, zeroCost: false,
    })
  })
  it('an opening holding with unknown basis stores null basis (unknown, not zero)', async () => {
    m.evCreate.mockResolvedValue(evRow({ type: 'OPENING', consideration: null, fee: null }))
    await post({ type: 'OPENING', occurredAt: past, quantity: '10' })
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ type: 'OPENING', basis: null, consideration: null, fee: null, zeroCost: false })
  })
  it('a zero cost must be confirmed explicitly', async () => {
    expect((await post({ type: 'OPENING', occurredAt: past, quantity: '10', basis: '0' })).statusCode).toBe(400)
    expect((await post({ type: 'OPENING', occurredAt: past, quantity: '10', zeroCost: true })).statusCode).toBe(400)
    m.evCreate.mockResolvedValue(evRow({ type: 'OPENING' }))
    expect((await post({ type: 'OPENING', occurredAt: past, quantity: '10', basis: '0', zeroCost: true })).statusCode).toBe(201)
  })
  it.each([
    ['bad type', { type: 'TRANSFER' }], ['zero quantity', { quantity: '0' }], ['negative quantity', { quantity: '-1' }],
    ['NaN', { quantity: 'NaN' }], ['exponent', { quantity: '1e5' }], ['JSON number instead of string', { quantity: 5 }],
    ['too many decimals', { quantity: '0.0000000000000000001' }], ['oversized', { quantity: '9'.repeat(30) }],
    ['negative consideration', { consideration: '-10' }], ['negative fee', { fee: '-1' }],
    ['missing consideration', { consideration: undefined }], ['future date', { occurredAt: '2999-01-01T00:00:00Z' }],
    ['impossible date', { occurredAt: '2026-02-31T00:00:00Z' }], ['date without time', { occurredAt: '2026-01-02' }],
    ['pre-bitcoin date', { occurredAt: '1999-01-01T00:00:00Z' }], ['basis on a BUY', { basis: '5' }],
    ['unknown field', { userId: 'victim' }], ['bad request id', { clientRequestId: 'x' }],
  ])('rejects %s', async (_l, over) => {
    const body = { type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', ...over }
    const res = await post(body)
    expect(res.statusCode).toBe(400)
    expect(m.evCreate).not.toHaveBeenCalled()
  })
  it('cleans the note of invisible characters and caps it', async () => {
    m.evCreate.mockResolvedValue(evRow())
    await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', note: 'ok' + String.fromCodePoint(0x202e) + 'evil' })
    expect(m.evCreate.mock.calls[0]![0].data.note).toBe('ok evil')
  })
  it('a retried submit with the same request id returns the original and writes nothing', async () => {
    m.evFindFirst.mockResolvedValue(evRow())
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '100', consideration: '100000', clientRequestId: 'req-12345678' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.id).toBe('ev1')
    expect(m.evCreate).not.toHaveBeenCalled()
  })
  it('reusing a request id for a different token is a conflict', async () => {
    m.evFindFirst.mockResolvedValue(evRow({ assetId: 'other' }))
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '1', clientRequestId: 'req-12345678' })
    expect(res.statusCode).toBe(409)
  })
  it('enforces the per-user cap', async () => {
    m.evCount.mockResolvedValue(MAX_PORTFOLIO_EVENTS)
    expect((await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '1' })).statusCode).toBe(400)
    expect(m.evCreate).not.toHaveBeenCalled()
  })
})

describe('manual price', () => {
  it('records a price observation, never a transaction', async () => {
    m.prCreate.mockResolvedValue({ price: dec('1200'), observedAt: new Date(NOW) })
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '1200' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.price).toBe('1200')
    expect(m.evCreate).not.toHaveBeenCalled()
  })
  it('stores the chosen price source (default "manual") and rejects free text', async () => {
    m.prCreate.mockResolvedValue({ price: dec('13'), observedAt: new Date(NOW) })
    await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '13', source: 'p2p' } })
    expect(m.prCreate.mock.calls.at(-1)![0].data.source).toBe('p2p')
    await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '13' } })
    expect(m.prCreate.mock.calls.at(-1)![0].data.source).toBe('manual')
    const bad = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '13', source: '<script>' } })
    expect(bad.statusCode).toBe(400)
  })
  it.each([['0'], ['-1'], ['abc'], ['1e3']])('rejects price %j', async (price) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price } })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /portfolio/summary runs the FIFO engine on stored records', () => {
  const ev = (id: string, assetId: string, type: string, at: string, quantity: string, consideration: string | null, fee: string | null, extra = {}) =>
    evRow({ id, assetId, type, occurredAt: new Date(at), quantity: dec(quantity), consideration: consideration && dec(consideration), fee: fee && dec(fee), ...extra })
  const stored = () => [
    ev('1', 'MEC', 'BUY', '2026-01-01T00:00:00Z', '100', '100000', '1000'),
    ev('2', 'MEC', 'SELL', '2026-01-02T00:00:00Z', '40', '52000', '400'),
    ev('3', 'USDT', 'BUY', '2026-01-03T00:00:00Z', '400', '111200', '0'),
    ev('4', 'SDA', 'BUY', '2026-01-03T00:00:00Z', '1000', '10000', '0'),
    ev('5', 'RUBI', 'BUY', '2026-01-03T00:00:00Z', '1000', '12000', '0'),
  ]
  const prices = (extra: Array<{ assetId: string; price: string }> = []) => [
    { assetId: 'MEC', price: dec('1200'), quote: 'PKR', observedAt: new Date(NOW) },
    { assetId: 'USDT', price: dec('280'), quote: 'PKR', observedAt: new Date(NOW) },
    { assetId: 'SDA', price: dec('8'), quote: 'PKR', observedAt: new Date(NOW) },
    { assetId: 'RUBI', price: dec('15'), quote: 'PKR', observedAt: new Date(NOW) },
    ...extra.map((p) => ({ assetId: p.assetId, price: dec(p.price), quote: 'PKR', observedAt: new Date(NOW) })),
  ]

  it('reproduces the spec aggregate: 207,000 / 193,800 / 13,200 / 11,200 / 24,400', async () => {
    m.evFindMany.mockResolvedValue(stored())
    m.prFindMany.mockResolvedValue(prices())
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.currency).toBe('PKR')
    expect(d.method).toBe('FIFO')
    expect(d.summary).toMatchObject({
      pricedValue: '207000', knownRemainingBasis: '193800', knownUnrealized: '13200', knownRealized: '11200', knownTotalPnl: '24400', partial: false,
    })
    const mec = d.summary.positions.find((p: { assetId: string }) => p.assetId === 'MEC')
    expect(mec).toMatchObject({ quantity: '60', knownRemainingBasis: '60600', realizedKnown: '11200', value: '72000', unrealized: '11400' })
  })
  it('a fifth asset with no price and unknown basis forces partial and is not valued at zero', async () => {
    m.evFindMany.mockResolvedValue([...stored(), ev('6', 'custom', 'OPENING', '2026-01-04T00:00:00Z', '500', null, null, { basis: null })])
    m.prFindMany.mockResolvedValue(prices())
    const d = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })).json().data
    expect(d.summary.partial).toBe(true)
    expect(d.summary.unpricedAssets).toEqual(['custom'])
    expect(d.summary.unknownBasisAssets).toEqual(['custom'])
    expect(d.summary.pricedValue).toBe('207000')
    expect(d.summary.positions.find((p: { assetId: string }) => p.assetId === 'custom').value).toBeNull()
  })
  it('an empty portfolio is a valid, empty, non-partial summary', async () => {
    m.evFindMany.mockResolvedValue([])
    m.prFindMany.mockResolvedValue([])
    const d = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })).json().data
    expect(d.summary.positions).toEqual([])
    expect(d.summary.partial).toBe(false)
  })
  it('only reads the caller\'s records', async () => {
    m.evFindMany.mockResolvedValue([])
    m.prFindMany.mockResolvedValue([])
    await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', voidedAt: null, archivedInPeriodId: null }) // voided entries never count
    expect(m.prFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
  })
  it('does not leak internals when stored data is corrupt', async () => {
    m.evFindMany.mockResolvedValue([ev('x', 'A', 'BUY', '2026-01-01T00:00:00Z', '1', '10', '0', { quantity: dec('-1') })])
    m.prFindMany.mockResolvedValue([])
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('PORTFOLIO_CALC_FAILED')
    expect(res.body).not.toMatch(/invalid quantity/)
  })
})

describe('currency and exchange rate', () => {
  const recent = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

  it('stamps the platform USDT/PKR rate on a record dated now', async () => {
    m.cfg.mockResolvedValue('281.5')
    m.evCreate.mockResolvedValue(evRow())
    await post({ type: 'BUY', occurredAt: recent(), quantity: '1', consideration: '10', quote: 'USDT' })
    expect(m.cfg).toHaveBeenCalledWith('rate_USDT_PKR', '')
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ quote: 'USDT', fxRate: '281.5', fxSource: 'platform' })
  })
  it('does NOT stamp today\'s rate on an old record (history is never rebuilt at the wrong rate)', async () => {
    m.cfg.mockResolvedValue('281.5')
    m.evCreate.mockResolvedValue(evRow())
    await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10' })
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ quote: 'PKR', fxRate: null, fxSource: null })
  })
  it('a rate typed by the user is stored as manual, even on an old record, and the platform rate is not read', async () => {
    m.cfg.mockResolvedValue('999')
    m.evCreate.mockResolvedValue(evRow())
    await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', fxRate: '275' })
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ fxRate: '275', fxSource: 'manual' })
    expect(m.cfg).not.toHaveBeenCalled()
  })
  it.each([[{ quote: 'EUR' }], [{ fxRate: '0' }], [{ fxRate: '-1' }], [{ fxRate: 'abc' }], [{ fxRate: '1e3' }]])('rejects %j', async (over) => {
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', ...over })
    expect(res.statusCode).toBe(400)
    expect(m.evCreate).not.toHaveBeenCalled()
  })
  it('returns currency and rate in the record, as strings', async () => {
    m.evFindMany.mockResolvedValue([evRow({ quote: 'USDT', fxRate: dec('280'), fxSource: 'manual' })])
    const e = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/a1/events', headers: U })).json().data[0]
    expect(e).toMatchObject({ quote: 'USDT', fxRate: '280', fxSource: 'manual' })
  })
  it('a price can be entered in USDT and defaults to PKR', async () => {
    m.prCreate.mockResolvedValue({ price: dec('2'), quote: 'USDT', observedAt: new Date(NOW) })
    await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '2', quote: 'USDT' } })
    expect(m.prCreate.mock.calls[0]![0].data.quote).toBe('USDT')
    m.prCreate.mockClear()
    await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '2' } })
    expect(m.prCreate.mock.calls[0]![0].data.quote).toBe('PKR')
  })

  describe('GET /portfolio/summary?currency=', () => {
    const stored = () => [evRow({ id: 'x1', assetId: 'A', quantity: dec('10'), consideration: dec('2800'), fee: dec('0'), fxRate: dec('280') })]
    it('rejects an unknown currency', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary?currency=EUR', headers: U })
      expect(res.statusCode).toBe(400)
    })
    it('defaults to PKR and can report in USDT using each record\'s own rate', async () => {
      m.evFindMany.mockResolvedValue(stored())
      m.prFindMany.mockResolvedValue([])
      m.cfg.mockResolvedValue('999')
      const pkr = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary', headers: U })).json().data
      expect(pkr.currency).toBe('PKR')
      expect(pkr.summary.positions[0].knownRemainingBasis).toBe('2800')
      const usdt = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary?currency=USDT', headers: U })).json().data
      expect(usdt.currency).toBe('USDT')
      expect(usdt.summary.positions[0].knownRemainingBasis).toBe('10') // 2800 / 280, not / 999
      expect(usdt.fx.usdtPkr).toBe('999')
    })
    it('shows an imported platform trade in USDT at the platform rate, but never does that for a typed-in entry', async () => {
      m.cfg.mockResolvedValue('280')
      m.evFindMany.mockResolvedValue([evRow({ id: 'c1', assetId: 'LINKED', fxRate: null, source: 'ctm' }), evRow({ id: 'x3', assetId: 'TYPED', fxRate: null })])
      m.prFindMany.mockResolvedValue([])
      const d = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary?currency=USDT', headers: U })).json().data
      expect(d.fxUnavailableAssets).toEqual(['TYPED'])
    })
    it('lists tokens that cannot be shown in USDT because no rate was recorded', async () => {
      m.evFindMany.mockResolvedValue([evRow({ id: 'x2', assetId: 'OLD', fxRate: null })])
      m.prFindMany.mockResolvedValue([])
      const d = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/summary?currency=USDT', headers: U })).json().data
      expect(d.fxUnavailableAssets).toEqual(['OLD'])
      expect(d.summary.partial).toBe(true)
    })
  })
})

describe('bounds and races', () => {
  it('price history is capped per user, like entries', async () => {
    m.prCount.mockResolvedValue(MAX_PORTFOLIO_EVENTS)
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/price', headers: U, payload: { price: '5' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PORTFOLIO_PRICE_LIMIT')
    expect(m.prCreate).not.toHaveBeenCalled()
  })
  it('two saves with the same request id at the same instant: the loser gets the saved entry, not an error', async () => {
    m.evCreate.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    m.evFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(evRow({ id: 'winner' }))
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', clientRequestId: 'req-12345678' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.id).toBe('winner')
    expect(m.evFindFirst.mock.calls[1]![0].where).toEqual({ userId: 'u1', clientRequestId: 'req-12345678', assetId: 'a1' })
  })
  it('any other database error is not swallowed', async () => {
    m.evCreate.mockRejectedValue(new Error('connection lost'))
    const res = await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10', clientRequestId: 'req-12345678' })
    expect(res.statusCode).toBe(500)
  })
  it('a uniqueness error without a request id is also not hidden', async () => {
    m.evCreate.mockRejectedValue(Object.assign(new Error('x'), { code: 'P2002' }))
    expect((await post({ type: 'BUY', occurredAt: past, quantity: '1', consideration: '10' })).statusCode).toBe(500)
  })
})