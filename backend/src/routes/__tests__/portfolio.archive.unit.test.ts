import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const m = vi.hoisted(() => ({
  aFindMany: vi.fn(), aFindFirst: vi.fn(), aUpdateMany: vi.fn(), aDeleteMany: vi.fn(), aCount: vi.fn(), aCreate: vi.fn(),
  evCount: vi.fn(), evFindMany: vi.fn(), evFindFirst: vi.fn(), evCreate: vi.fn(),
  prDeleteMany: vi.fn(), prCreate: vi.fn(), intFindMany: vi.fn(),
}))

vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findMany: m.aFindMany, findFirst: m.aFindFirst, updateMany: m.aUpdateMany, deleteMany: m.aDeleteMany, count: m.aCount, create: m.aCreate },
    portfolioEvent: { count: m.evCount, findMany: m.evFindMany, findFirst: m.evFindFirst, create: m.evCreate },
    portfolioPriceObservation: { deleteMany: m.prDeleteMany, create: m.prCreate },
    portfolioListingInterest: { findMany: m.intFindMany },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: async () => '', getBoolConfig: async () => true }))
vi.mock('../../services/portfolioPeriod.service', async (orig) => ({ ...(await orig<typeof import('../../services/portfolioPeriod.service')>()), getActivePeriod: async () => null, ensurePeriodForNewPortfolio: async () => null }))
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
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = U) =>
  app.inject({ method, url: `/api/v1${url}`, headers, ...(payload ? { payload } : {}) })
const asset = (o = {}) => ({ id: 'a1', name: 'X', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date(), archivedAt: null, ...o })
const goodEvent = { type: 'BUY', occurredAt: '2026-01-02T00:00:00.000Z', quantity: '1', consideration: '10' }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.aFindFirst.mockResolvedValue({ id: 'a1', archivedAt: null })
  m.evCount.mockResolvedValue(0)
  m.evFindFirst.mockResolvedValue(null)
  m.aCount.mockResolvedValue(0)
  m.intFindMany.mockResolvedValue([])
})

describe('listing', () => {
  it('hides archived tokens by default and shows them on request, as ISO dates', async () => {
    m.aFindMany.mockResolvedValue([asset({ archivedAt: new Date('2026-10-01T00:00:00Z') })])
    const res = await call('GET', '/portfolio/assets?includeArchived=1')
    expect(m.aFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
    expect(res.json().data[0].archivedAt).toBe('2026-10-01T00:00:00.000Z')
    m.aFindMany.mockResolvedValue([asset()])
    const def = await call('GET', '/portfolio/assets')
    expect(m.aFindMany.mock.calls[1]![0].where).toEqual({ userId: 'u1', archivedAt: null })
    expect(def.json().data[0].archivedAt).toBeNull()
  })
  it('rejects an unexpected query value', async () => {
    expect((await call('GET', '/portfolio/assets?includeArchived=maybe')).statusCode).toBe(400)
  })
})

describe('archive and restore', () => {
  it('requires authentication', async () => {
    expect((await call('POST', '/portfolio/assets/a1/archive', undefined, {})).statusCode).toBe(401)
    expect((await call('POST', '/portfolio/assets/a1/unarchive', undefined, {})).statusCode).toBe(401)
    expect((await call('DELETE', '/portfolio/assets/a1', undefined, {})).statusCode).toBe(401)
  })
  it('archives only the caller\'s not-yet-archived token', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 1 })
    expect((await call('POST', '/portfolio/assets/a1/archive')).statusCode).toBe(200)
    const arg = m.aUpdateMany.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: 'a1', userId: 'u1', archivedAt: null })
    expect(arg.data.archivedAt).toBeInstanceOf(Date)
  })
  it('another user\'s token is a 404; an already-archived one is a 409', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 0 })
    m.aFindFirst.mockResolvedValueOnce(null)
    expect((await call('POST', '/portfolio/assets/theirs/archive')).statusCode).toBe(404)
    m.aFindFirst.mockResolvedValueOnce({ id: 'a1' })
    expect((await call('POST', '/portfolio/assets/a1/archive')).statusCode).toBe(409)
  })
  it('restores a token by clearing archivedAt, scoped to the caller', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 1 })
    expect((await call('POST', '/portfolio/assets/a1/unarchive')).statusCode).toBe(200)
    expect(m.aUpdateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'a1', userId: 'u1', archivedAt: { not: null } }, data: { archivedAt: null } })
  })
  it('never touches events or prices', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 1 })
    await call('POST', '/portfolio/assets/a1/archive')
    expect(m.prDeleteMany).not.toHaveBeenCalled()
    expect(m.aDeleteMany).not.toHaveBeenCalled()
  })
})

describe('delete (only when there are no records)', () => {
  it('deletes a token with no records, and its price notes, scoped to the caller', async () => {
    m.evCount.mockResolvedValue(0)
    m.prDeleteMany.mockResolvedValue({ count: 2 })
    m.aDeleteMany.mockResolvedValue({ count: 1 })
    expect((await call('DELETE', '/portfolio/assets/a1')).statusCode).toBe(200)
    expect(m.prDeleteMany.mock.calls[0]![0].where).toEqual({ assetId: 'a1', userId: 'u1' })
    expect(m.aDeleteMany.mock.calls[0]![0].where).toEqual({ id: 'a1', userId: 'u1', events: { none: {} } })
  })
  it('refuses when the token has records, and deletes nothing', async () => {
    m.evCount.mockResolvedValue(3)
    const res = await call('DELETE', '/portfolio/assets/a1')
    expect(res.statusCode).toBe(409)
    expect(res.json().error.message).toMatch(/Archive it instead/)
    expect(m.prDeleteMany).not.toHaveBeenCalled()
    expect(m.aDeleteMany).not.toHaveBeenCalled()
  })
  it('if a record appears at the last moment the guarded delete removes nothing and reports a conflict', async () => {
    m.prDeleteMany.mockResolvedValue({ count: 0 })
    m.aDeleteMany.mockResolvedValue({ count: 0 })
    expect((await call('DELETE', '/portfolio/assets/a1')).statusCode).toBe(409)
  })
  it('another user\'s token is a 404 and nothing is deleted', async () => {
    m.aFindFirst.mockResolvedValue(null)
    expect((await call('DELETE', '/portfolio/assets/theirs')).statusCode).toBe(404)
    expect(m.aDeleteMany).not.toHaveBeenCalled()
  })
})

describe('archived tokens are read-only for new records', () => {
  const archived = () => m.aFindFirst.mockResolvedValue({ id: 'a1', archivedAt: new Date() })
  it('recording an entry or a price returns 409 and writes nothing', async () => {
    archived()
    const e = await call('POST', '/portfolio/assets/a1/events', goodEvent)
    expect(e.statusCode).toBe(409)
    expect(e.json().error.message).toMatch(/Restore it/)
    expect((await call('POST', '/portfolio/assets/a1/price', { price: '5' })).statusCode).toBe(409)
    expect(m.evCreate).not.toHaveBeenCalled()
    expect(m.prCreate).not.toHaveBeenCalled()
  })
  it('the history of an archived token can still be read', async () => {
    archived()
    m.evFindMany.mockResolvedValue([])
    expect((await call('GET', '/portfolio/assets/a1/events')).statusCode).toBe(200)
  })
})
