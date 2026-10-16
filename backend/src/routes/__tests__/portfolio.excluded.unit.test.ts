import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  list: vi.fn(), check: vi.fn(), ensure: vi.fn(),
  evFindFirst: vi.fn(), evCount: vi.fn(), evCreate: vi.fn(),
  cfg: vi.fn(),
}))

// Only portfolio tables exist on this mock, and the platform side is the (mocked) read-only service:
// recording a trade by hand cannot write to a trade, wallet, order or settlement table.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioEvent: { findFirst: m.evFindFirst, count: m.evCount, create: m.evCreate },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/portfolioImport.service', () => ({
  runCtmImport: vi.fn(),
  listExcludedTrades: m.list,
  checkExcludedTradeRecordable: m.check,
  ensureLinkedAsset: m.ensure,
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.cfg, getBoolConfig: async () => true }))
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
const past = '2026-10-01T10:00:00.000Z'
const body = (o: Record<string, unknown> = {}) => ({ type: 'BUY', occurredAt: past, quantity: '100', consideration: '125000', quote: 'PKR', ...o })
const record = (payload: unknown, headers: Record<string, string> = U, id = 'trade1') =>
  app.inject({ method: 'POST', url: `/api/v1/portfolio/excluded-trades/${id}/record`, headers, payload: payload as object })
const created = () => ({
  id: 'ev1', assetId: 'asset1', type: 'BUY', occurredAt: new Date(past), quantity: dec('100'), consideration: dec('125000'),
  fee: dec('0'), basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(past),
  source: 'manual', voidedAt: null, voidReason: null, editedAt: null, linkedTradeRef: 'trade1',
})

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.cfg.mockResolvedValue('280')
  m.check.mockResolvedValue({ ok: true, side: 'BUY', token: { id: 'tok1' }, tradeId: 'trade1' })
  m.ensure.mockResolvedValue('asset1')
  m.evFindFirst.mockResolvedValue(null)
  m.evCount.mockResolvedValue(0)
  m.evCreate.mockResolvedValue(created())
})

describe('GET /portfolio/import/excluded', () => {
  it('requires sign-in and returns the caller list with paging', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/portfolio/import/excluded' })).statusCode).toBe(401)
    m.list.mockResolvedValue({ total: 1, items: [{ tradeId: 'trade1' }] })
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/import/excluded?limit=10&offset=20', headers: U })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ total: 1, items: [{ tradeId: 'trade1' }] })
    expect(m.list).toHaveBeenCalledWith('u1', { limit: 10, offset: 20 })
  })
  it('uses safe defaults and rejects absurd paging values', async () => {
    m.list.mockResolvedValue({ total: 0, items: [] })
    await app.inject({ method: 'GET', url: '/api/v1/portfolio/import/excluded', headers: U })
    expect(m.list).toHaveBeenCalledWith('u1', { limit: 25, offset: 0 })
    for (const q of ['limit=0', 'limit=1000', 'offset=-1', 'limit=abc']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/portfolio/import/excluded?${q}`, headers: U })).statusCode, q).toBe(400)
    }
  })
  it('a failure reads as a try-again message and leaks nothing', async () => {
    m.list.mockRejectedValue(new Error('db password is hunter2'))
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/import/excluded', headers: U })
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.json())).not.toContain('hunter2')
  })
})

describe('POST /portfolio/excluded-trades/:tradeId/record', () => {
  it('requires sign-in', async () => {
    expect((await record(body(), {})).statusCode).toBe(401)
  })

  it('records a manual entry linked to the trade, on the token that mirrors it', async () => {
    const res = await record(body())
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({ id: 'ev1', source: 'manual', linkedTradeRef: 'trade1' })
    expect(m.check).toHaveBeenCalledWith('u1', 'trade1')
    const data = m.evCreate.mock.calls[0]![0].data
    expect(data).toMatchObject({ userId: 'u1', assetId: 'asset1', type: 'BUY', quantity: '100', consideration: '125000', linkedTradeRef: 'trade1', basis: null, zeroCost: false })
    expect(data).not.toHaveProperty('source') // defaults to manual: never marked as an imported trade
    expect(data).not.toHaveProperty('sourceRef')
  })

  it("someone else's trade, an unknown trade, or one that cannot be recorded never creates anything", async () => {
    m.check.mockResolvedValue({ ok: false, status: 404, message: 'Trade not found' })
    expect((await record(body())).statusCode).toBe(404)
    m.check.mockResolvedValue({ ok: false, status: 409, message: 'This trade is added to your portfolio automatically.' })
    const res = await record(body())
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toMatch(/automatically/)
    expect(m.ensure).not.toHaveBeenCalled()
    expect(m.evCreate).not.toHaveBeenCalled()
  })

  it('must match the side the user had in the trade, and cannot be an opening holding', async () => {
    const wrongSide = await record(body({ type: 'SELL' }))
    expect(wrongSide.statusCode).toBe(400)
    expect(wrongSide.json().error.message).toMatch(/buyer/)
    expect((await record({ type: 'OPENING', occurredAt: past, quantity: '1' })).statusCode).toBe(400)
    expect(m.evCreate).not.toHaveBeenCalled()
  })

  it('a trade can be recorded only once', async () => {
    m.evFindFirst.mockResolvedValue({ id: 'already' })
    const res = await record(body())
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toMatch(/already recorded/)
    expect(m.evCreate).not.toHaveBeenCalled()
    // ...and the database uniqueness rule stops two simultaneous requests
    m.evFindFirst.mockResolvedValue(null)
    m.evCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    expect((await record(body())).statusCode).toBe(409)
  })

  it('applies the same validation as any entry', async () => {
    for (const bad of [body({ quantity: '0' }), body({ quantity: '1e3' }), body({ consideration: undefined }), body({ occurredAt: '2999-01-01T00:00:00Z' }), body({ extra: 1 })]) {
      expect((await record(bad)).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect(m.check).not.toHaveBeenCalled()
  })

  it('respects the per-user limits', async () => {
    m.evCount.mockResolvedValue(MAX_PORTFOLIO_EVENTS)
    expect((await record(body())).json().error.code).toBe('PORTFOLIO_EVENT_LIMIT')
    m.evCount.mockResolvedValue(0)
    m.ensure.mockResolvedValue(null)
    expect((await record(body())).json().error.code).toBe('PORTFOLIO_ASSET_LIMIT')
    expect(m.evCreate).not.toHaveBeenCalled()
  })

  it('stamps a rate only the same way as a normal entry: a typed rate wins, an old entry gets none', async () => {
    await record(body({ quote: 'USDT', fxRate: '282' }))
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ fxRate: '282', fxSource: 'manual' })
    await record(body({ quote: 'USDT' })) // dated long ago, no rate typed
    expect(m.evCreate.mock.calls[1]![0].data).toMatchObject({ fxRate: null, fxSource: null })
  })
})
