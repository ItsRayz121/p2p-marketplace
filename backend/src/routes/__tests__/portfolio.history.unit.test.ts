import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  assetFindFirst: vi.fn(), evFindMany: vi.fn(), evCount: vi.fn(), evCreate: vi.fn(), evFindFirst: vi.fn(), cfg: vi.fn(),
}))

// Only portfolio tables exist on this mock; touching anything else throws.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findFirst: m.assetFindFirst },
    portfolioEvent: { findMany: m.evFindMany, count: m.evCount, create: m.evCreate, findFirst: m.evFindFirst },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
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
const past = '2026-01-02T00:00:00.000Z'
const row = (o: Record<string, unknown> = {}) => ({
  id: 'ev1', assetId: 'a1', type: 'BUY', occurredAt: new Date(past), quantity: dec('100'), consideration: dec('100000'),
  fee: dec('1000'), basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(past),
  source: 'manual', voidedAt: null, voidReason: null, editedAt: null, linkedTradeRef: null, priceBasis: null,
  asset: { name: 'Meta Earth', symbol: 'MEC' }, ...o,
})
const get = (qs = '', headers: Record<string, string> = U) => app.inject({ method: 'GET', url: `/api/v1/portfolio/events${qs}`, headers })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.evCount.mockResolvedValue(1)
  m.evFindMany.mockResolvedValue([row()])
  m.assetFindFirst.mockResolvedValue({ id: 'a1', archivedAt: null })
  m.cfg.mockResolvedValue('')
})

describe('GET /portfolio/events (all transactions)', () => {
  it('requires sign-in and is always scoped to the caller', async () => {
    expect((await get('', {})).statusCode).toBe(401)
    await get()
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
    expect(m.evCount.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
  })

  it('returns a page with the token name, and never the owner or internal fields', async () => {
    const res = await get()
    expect(res.statusCode).toBe(200)
    const { total, items } = res.json().data
    expect(total).toBe(1)
    expect(items[0]).toMatchObject({ id: 'ev1', assetId: 'a1', assetName: 'Meta Earth', assetSymbol: 'MEC', quantity: '100', source: 'manual', priceBasis: null })
    expect(items[0]).not.toHaveProperty('userId')
    expect(items[0]).not.toHaveProperty('asset')
    expect(items[0]).not.toHaveProperty('sourceRef')
  })

  it('pages newest first with a stable order', async () => {
    await get('?limit=10&offset=20')
    const arg = m.evFindMany.mock.calls[0]![0]
    expect([arg.take, arg.skip]).toEqual([10, 20])
    expect(arg.orderBy).toEqual([{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }])
  })

  it('applies type, source, status and token filters while keeping the caller scope', async () => {
    await get('?type=SELL&source=ctm&status=not_counted&assetId=a9')
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', type: 'SELL', source: 'ctm', voidedAt: { not: null }, assetId: 'a9' })
    await get('?status=counted')
    expect(m.evFindMany.mock.calls[1]![0].where).toEqual({ userId: 'u1', voidedAt: null })
  })

  it('searches the note, token name and symbol without leaving the caller scope', async () => {
    await get('?q=meta')
    const where = m.evFindMany.mock.calls[0]![0].where
    expect(where.userId).toBe('u1')
    expect(where.OR).toEqual([
      { note: { contains: 'meta', mode: 'insensitive' } },
      { asset: { name: { contains: 'meta', mode: 'insensitive' } } },
      { asset: { symbol: { contains: 'meta', mode: 'insensitive' } } },
    ])
  })

  it.each([['limit=0'], ['limit=101'], ['offset=-1'], ['type=HODL'], ['source=other'], ['status=weird'], ['q=' + 'x'.repeat(61)], ['userId=u2'], ['limit=abc']])('rejects %s', async (qs) => {
    expect((await get('?' + qs)).statusCode).toBe(400)
    expect(m.evFindMany).not.toHaveBeenCalled()
  })

  it('only reads: no write method exists on the mock for this route', async () => {
    await get('?q=a')
    expect(m.evCreate).not.toHaveBeenCalled()
  })
})

describe('price basis on a buy or sell', () => {
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/portfolio/assets/a1/events', headers: U, payload: payload as object })
  const base = { type: 'BUY', occurredAt: past, quantity: '100', consideration: '1200', fee: '0' }

  it('stores the chosen basis, and nothing when none is given', async () => {
    m.evCreate.mockResolvedValue(row({ priceBasis: 'platform' }))
    const res = await post({ ...base, priceBasis: 'platform' })
    expect(res.statusCode).toBe(201)
    expect(m.evCreate.mock.calls[0]![0].data.priceBasis).toBe('platform')
    expect(res.json().data.priceBasis).toBe('platform')
    await post(base)
    expect(m.evCreate.mock.calls[1]![0].data.priceBasis).toBeNull()
  })

  it('accepts only the two known values, and not for an opening holding', async () => {
    expect((await post({ ...base, priceBasis: 'market' })).statusCode).toBe(400)
    expect((await post({ type: 'OPENING', occurredAt: past, quantity: '5', priceBasis: 'own' })).statusCode).toBe(400)
    expect(m.evCreate).not.toHaveBeenCalled()
  })
})
