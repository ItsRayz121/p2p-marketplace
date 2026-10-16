import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  evFindFirst: vi.fn(), evUpdateMany: vi.fn(),
  revCreate: vi.fn(), revCount: vi.fn(), revFindMany: vi.fn(),
  cfg: vi.fn(),
}))

// Only portfolio tables exist on this mock; touching anything else throws, which proves that editing
// an entry cannot reach wallets, trades, orders or settlement.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findFirst: m.assetFindFirst },
    portfolioEvent: { findFirst: m.evFindFirst, updateMany: m.evUpdateMany },
    portfolioEventRevision: { create: m.revCreate, count: m.revCount, findMany: m.revFindMany },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      portfolioEvent: { updateMany: m.evUpdateMany, findFirst: m.evFindFirst },
      portfolioEventRevision: { create: m.revCreate },
    }),
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.cfg, getBoolConfig: async () => true }))
vi.mock('../../services/portfolioMarks.service', async (orig) => ({ ...(await orig<typeof import('../../services/portfolioMarks.service')>()), platformMarksFor: async () => [], logosFor: async () => new Map() }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: async (req: { headers: Record<string, string | undefined>; user?: { id: string } }) => {
    const id = req.headers['x-test-user']
    if (!id) { const { AppError } = await import('../../lib/errors'); throw new AppError('UNAUTHORIZED', 'Authentication required', 401) }
    req.user = { id }
  },
}))

import { portfolioRoutes, MAX_REVISIONS_PER_EVENT } from '../portfolio.routes'
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
const past = '2026-01-02T00:00:00.000Z'
const row = (o: Record<string, unknown> = {}) => ({
  id: 'ev1', assetId: 'a1', type: 'BUY', occurredAt: new Date(past), quantity: dec('100'), consideration: dec('100000'),
  fee: dec('1000'), basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(past),
  source: 'manual', voidedAt: null, voidReason: null, editedAt: null, ...o,
})
const patch = (payload: unknown, headers: Record<string, string> = U, url = '/api/v1/portfolio/assets/a1/events/ev1') =>
  app.inject({ method: 'PATCH', url, headers, payload: payload as object })
const body = (o: Record<string, unknown> = {}) => ({ type: 'BUY', occurredAt: past, quantity: '120', consideration: '130000', fee: '500', ...o })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.assetFindFirst.mockResolvedValue({ id: 'a1', archivedAt: null })
  m.revCount.mockResolvedValue(0)
  m.cfg.mockResolvedValue('280')
  m.evUpdateMany.mockResolvedValue({ count: 1 })
  m.evFindFirst.mockResolvedValueOnce(row()).mockResolvedValue(row({ quantity: dec('120'), consideration: dec('130000'), fee: dec('500'), editedAt: new Date() }))
})

describe('PATCH /portfolio/assets/:id/events/:eventId', () => {
  it('requires sign-in', async () => {
    expect((await patch(body(), {})).statusCode).toBe(401)
  })

  it('corrects the entry and keeps the earlier version in its history, in one transaction', async () => {
    const res = await patch(body())
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ id: 'ev1', quantity: '120', consideration: '130000', fee: '500' })
    expect(res.json().data.editedAt).toBeTruthy()
    expect(m.revCreate).toHaveBeenCalledTimes(1)
    expect(m.revCreate.mock.calls[0]![0].data).toMatchObject({
      userId: 'u1', eventId: 'ev1', assetId: 'a1', action: 'edit',
      before: { type: 'BUY', quantity: '100', consideration: '100000', fee: '1000', quote: 'PKR' },
    })
    const upd = m.evUpdateMany.mock.calls[0]![0]
    expect(upd.where).toMatchObject({ id: 'ev1', assetId: 'a1', userId: 'u1', source: 'manual', editedAt: null })
    expect(upd.data).toMatchObject({ quantity: '120', consideration: '130000', fee: '500', zeroCost: false, basis: null })
    expect(upd.data.editedAt).toBeInstanceOf(Date)
  })

  it('never changes the owner, the token, the origin or any imported field', async () => {
    await patch(body())
    const keys = Object.keys(m.evUpdateMany.mock.calls[0]![0].data)
    for (const k of ['userId', 'assetId', 'source', 'sourceRef', 'voidedAt', 'clientRequestId', 'createdAt']) expect(keys).not.toContain(k)
  })

  it('an entry imported from a RupChain trade is read-only', async () => {
    m.evFindFirst.mockReset()
    m.evFindFirst.mockResolvedValue(row({ source: 'ctm' }))
    const res = await patch(body())
    expect(res.statusCode).toBe(409)
    expect(m.evUpdateMany).not.toHaveBeenCalled()
    expect(m.revCreate).not.toHaveBeenCalled()
  })

  it("another user's entry or token looks exactly like a missing one", async () => {
    m.evFindFirst.mockReset()
    m.evFindFirst.mockResolvedValue(null)
    expect((await patch(body())).statusCode).toBe(404)
    expect(m.evFindFirst.mock.calls[0]![0].where).toEqual({ id: 'ev1', assetId: 'a1', userId: 'u1' })
    m.assetFindFirst.mockResolvedValue(null)
    expect((await patch(body())).statusCode).toBe(404)
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })

  it('an archived token cannot be edited until restored', async () => {
    m.assetFindFirst.mockResolvedValue({ id: 'a1', archivedAt: new Date() })
    expect((await patch(body())).statusCode).toBe(409)
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })

  it('applies the same validation as a new record', async () => {
    for (const bad of [body({ quantity: '0' }), body({ quantity: '1e3' }), body({ consideration: undefined }), body({ occurredAt: '2999-01-01T00:00:00Z' }), body({ type: 'OPENING' }), body({ foo: 1 })]) {
      expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })

  it('a simultaneous change makes the correction fail instead of overwriting it', async () => {
    m.evUpdateMany.mockResolvedValue({ count: 0 })
    const res = await patch(body())
    expect(res.statusCode).toBe(409)
    expect(m.revCreate).not.toHaveBeenCalled()
  })

  it('stops after too many corrections of one entry', async () => {
    m.revCount.mockResolvedValue(MAX_REVISIONS_PER_EVENT)
    const res = await patch(body())
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PORTFOLIO_HISTORY_LIMIT')
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })

  it('keeps the exchange rate stored with the entry when its date and currency are unchanged', async () => {
    m.evFindFirst.mockReset()
    m.evFindFirst.mockResolvedValueOnce(row({ quote: 'USDT', fxRate: dec('281.5'), fxSource: 'manual' })).mockResolvedValue(row())
    await patch(body({ quote: 'USDT' }))
    expect(m.evUpdateMany.mock.calls[0]![0].data).toMatchObject({ fxRate: '281.5', fxSource: 'manual' })
  })

  it('never stamps today\'s rate on an old entry whose date or currency changed', async () => {
    m.evFindFirst.mockReset()
    m.evFindFirst.mockResolvedValueOnce(row()).mockResolvedValue(row())
    await patch(body({ quote: 'USDT' })) // currency changed, dated long ago, no rate typed
    expect(m.evUpdateMany.mock.calls[0]![0].data).toMatchObject({ fxRate: null, fxSource: null })
  })

  it('a rate typed by the user is stored as entered by the user', async () => {
    await patch(body({ quote: 'USDT', fxRate: '282' }))
    expect(m.evUpdateMany.mock.calls[0]![0].data).toMatchObject({ fxRate: '282', fxSource: 'manual' })
  })

  it('turning an entry into an opening holding clears the money fields', async () => {
    await patch({ type: 'OPENING', occurredAt: past, quantity: '50' })
    expect(m.evUpdateMany.mock.calls[0]![0].data).toMatchObject({ type: 'OPENING', consideration: null, fee: null, basis: null, zeroCost: false })
  })
})

describe('GET /portfolio/assets/:id/events/:eventId/history', () => {
  it('lists earlier versions newest first, scoped to the caller, and survives a removed entry', async () => {
    m.revFindMany.mockResolvedValue([{ id: 'r2', action: 'delete', before: { quantity: '120' }, createdAt: new Date('2026-02-02T00:00:00Z') }])
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/a1/events/ev1/history', headers: U })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([{ id: 'r2', action: 'delete', before: { quantity: '120' }, changedAt: '2026-02-02T00:00:00.000Z' }])
    const arg = m.revFindMany.mock.calls[0]![0]
    expect(arg.where).toEqual({ userId: 'u1', assetId: 'a1', eventId: 'ev1' })
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(res.json().data[0]).not.toHaveProperty('userId')
  })

  it("another user's token is a 404", async () => {
    m.assetFindFirst.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets/a1/events/ev1/history', headers: U })
    expect(res.statusCode).toBe(404)
    expect(m.revFindMany).not.toHaveBeenCalled()
  })
})
