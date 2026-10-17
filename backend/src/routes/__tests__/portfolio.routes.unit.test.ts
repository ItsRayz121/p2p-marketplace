import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), intFindMany: vi.fn(), intUpdateMany: vi.fn(),
}))

// Any model other than portfolioAsset throws, proving these routes never touch wallets,
// transactions, trades or any settlement table.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy(
    { portfolioAsset: { findMany: mocks.findMany, count: mocks.count, create: mocks.create, updateMany: mocks.updateMany, findFirst: mocks.findFirst }, portfolioListingInterest: { findMany: mocks.intFindMany, updateMany: mocks.intUpdateMany } },
    { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } },
  ),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: async () => '', getBoolConfig: async () => true }))
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

import { portfolioRoutes, MAX_PORTFOLIO_ASSETS } from '../portfolio.routes'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const as = (id: string) => ({ 'x-test-user': id })
const row = (over = {}) => ({ id: 'a1', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date(), ...over })

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.count.mockResolvedValue(0)
  mocks.intFindMany.mockResolvedValue([])
  mocks.intUpdateMany.mockResolvedValue({ count: 0 })
})

describe('auth and privacy headers', () => {
  it('requires authentication on every route', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', payload: { name: 'x' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', payload: { name: 'x' } })).statusCode).toBe(401)
  })
  it('marks responses private/no-store', async () => {
    mocks.findMany.mockResolvedValue([])
    const res = await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets', headers: as('u1') })
    expect(res.headers['cache-control']).toBe('private, no-store')
  })
})

describe('GET', () => {
  it('lists only the caller\'s assets', async () => {
    mocks.findMany.mockResolvedValue([row()])
    await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets', headers: as('u1') })
    expect(mocks.findMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', archivedAt: null })
  })
})

describe('POST', () => {
  it('creates with a name only, owned by the authenticated user', async () => {
    mocks.create.mockResolvedValue(row())
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload: { name: '  Meta   Earth ' } })
    expect(res.statusCode).toBe(201)
    expect(mocks.create.mock.calls[0]![0].data).toEqual({ userId: 'u1', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null })
  })
  it('does not accept a client-supplied owner or id (mass assignment)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload: { name: 'X', userId: 'victim', id: 'forced' } })
    expect(res.statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it.each([
    [{ name: '' }], [{ name: '   ' }], [{ name: 'X', sourceUrl: 'javascript:alert(1)' }],
    [{ name: 'X', sourceUrl: 'https://u:p@example.com' }], [{ name: 'X', sourceUrl: 'data:text/html,hi' }],
    [{ name: 'X', symbol: '<script>' }], [{ name: 'X', contractAddress: '0xabc' }], [{ name: 'a'.repeat(81) }],
    [{ name: 'X', sourceUrl: 'https://example.com/' + 'a'.repeat(2100) }], [{}], [{ name: 5 }],
  ])('rejects invalid input %j', async (payload) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload })
    expect(res.statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('rejects a link that would not fit in the database once normalised (instead of failing with a server error)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload: { name: 'X', sourceUrl: 'https://example.com/' + 'é'.repeat(700) } })
    expect(res.statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('accepts a blank/omitted link and an http/https link', async () => {
    mocks.create.mockResolvedValue(row())
    for (const sourceUrl of [undefined, null, '', '  ', 'https://example.com', 'http://example.com/x']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload: { name: 'X', sourceUrl } })
      expect(res.statusCode).toBe(201)
    }
  })
  it('same name, symbol and link never merge: each POST creates a separate asset', async () => {
    mocks.create.mockResolvedValueOnce(row({ id: 'a1' })).mockResolvedValueOnce(row({ id: 'a2' }))
    const payload = { name: 'Alpha', symbol: 'ALP', sourceUrl: 'https://alpha.example' }
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload })
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload })
    expect(r1.json().data.id).not.toBe(r2.json().data.id)
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.findFirst).not.toHaveBeenCalled() // no lookup-by-name-then-reuse
  })
  it('enforces the per-user cap', async () => {
    mocks.count.mockResolvedValue(MAX_PORTFOLIO_ASSETS)
    const res = await app.inject({ method: 'POST', url: '/api/v1/portfolio/assets', headers: as('u1'), payload: { name: 'X' } })
    expect(res.statusCode).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe('PATCH (metadata edits)', () => {
  it('updates only display fields of a row scoped to the caller', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findFirst.mockResolvedValue(row({ name: 'Renamed' }))
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: as('u1'), payload: { name: 'Renamed', symbol: 'RN' } })
    expect(res.statusCode).toBe(200)
    const call = mocks.updateMany.mock.calls[0]![0]
    expect(call.where).toEqual({ id: 'a1', userId: 'u1', ctmTokenId: null })
    expect(Object.keys(call.data).sort()).toEqual(['contractAddress', 'name', 'network', 'sourceUrl', 'symbol'])
  })
  it('another user\'s asset id is indistinguishable from a missing one (404)', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.findFirst.mockResolvedValue(null)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/theirs', headers: as('u1'), payload: { name: 'Hijack' } })
    expect(res.statusCode).toBe(404)
  })
  it('refuses to edit a token that mirrors a RupChain-listed token (409)', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.findFirst.mockResolvedValue({ id: 'a1' })
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: as('u1'), payload: { name: 'Renamed' } })
    expect(res.statusCode).toBe(409)
    expect(mocks.updateMany.mock.calls.at(-1)![0].where).toEqual({ id: 'a1', userId: 'u1', ctmTokenId: null })
  })
  it('rejects invalid metadata without writing', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: as('u1'), payload: { name: 'X', sourceUrl: 'javascript:alert(1)' } })
    expect(res.statusCode).toBe(400)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
  it('cannot be used to change identity or ownership fields', async () => {
    for (const extra of [{ userId: 'u2' }, { id: 'other' }, { quantity: '5' }, { costBasis: '1' }]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: as('u1'), payload: { name: 'X', ...extra } })
      expect(res.statusCode).toBe(400)
    }
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})

describe('validation parity with the frontend', () => {
  it('backend copy of the validation module is byte-identical to the frontend one', () => {
    const fe = readFileSync(path.resolve(__dirname, '../../../../frontend/src/lib/portfolio/customAsset.ts'), 'utf8')
    const be = readFileSync(path.resolve(__dirname, '../../lib/portfolioAsset.ts'), 'utf8')
    expect(be).toBe(fe)
  })
})
