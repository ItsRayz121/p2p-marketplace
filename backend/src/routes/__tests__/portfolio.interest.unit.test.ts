import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const m = vi.hoisted(() => ({
  aFindFirst: vi.fn(), aFindMany: vi.fn(), aUpdateMany: vi.fn(),
  userFind: vi.fn(), ctmFind: vi.fn(),
  inCount: vi.fn(), inFindFirst: vi.fn(), inUpsert: vi.fn(), inUpdateMany: vi.fn(), inFindMany: vi.fn(),
}))

vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findFirst: m.aFindFirst, findMany: m.aFindMany, updateMany: m.aUpdateMany },
    user: { findUnique: m.userFind },
    ctmToken: { findFirst: m.ctmFind },
    portfolioListingInterest: { count: m.inCount, findFirst: m.inFindFirst, upsert: m.inUpsert, updateMany: m.inUpdateMany, findMany: m.inFindMany },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: async () => '', getBoolConfig: async () => true }))
vi.mock('../../services/portfolioImport.service', () => ({ runCtmImport: vi.fn() }))
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
const consent = (payload: unknown = { consent: true }, id = 'a1', headers: Record<string, string> = U) =>
  app.inject({ method: 'POST', url: `/api/v1/portfolio/assets/${id}/interest`, headers, payload: payload as object })
const withdraw = (id = 'a1', headers: Record<string, string> = U) =>
  app.inject({ method: 'DELETE', url: `/api/v1/portfolio/assets/${id}/interest`, headers })
const asset = (o = {}) => ({ id: 'a1', name: 'Meta Earth', network: 'BEP20', contractAddress: '0xABCdef', ctmTokenId: null, ...o })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.aFindFirst.mockResolvedValue(asset())
  m.userFind.mockResolvedValue({ isEmailVerified: true, isBanned: false })
  m.ctmFind.mockResolvedValue(null)
  m.inCount.mockResolvedValue(0)
  m.inFindFirst.mockResolvedValue(null)
  m.inUpsert.mockResolvedValue({})
  m.inUpdateMany.mockResolvedValue({ count: 1 })
  m.inFindMany.mockResolvedValue([])
})

describe('giving consent', () => {
  it('requires authentication and an explicit { consent: true }', async () => {
    expect((await consent({ consent: true }, 'a1', {})).statusCode).toBe(401)
    for (const body of [{}, { consent: false }, { consent: 'yes' }, { consent: true, userId: 'victim' }]) {
      expect((await consent(body)).statusCode).toBe(400)
    }
    expect(m.inUpsert).not.toHaveBeenCalled()
  })
  it('records interest for a token with a network and contract, keyed by identity only', async () => {
    const res = await consent()
    expect(res.statusCode).toBe(200)
    expect(m.aFindFirst.mock.calls[0]![0].where).toEqual({ id: 'a1', userId: 'u1' })
    const arg = m.inUpsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ userId_identityKey: { userId: 'u1', identityKey: 'bep20:0xabcdef' } })
    expect(arg.create).toEqual({ userId: 'u1', assetId: 'a1', identityKey: 'bep20:0xabcdef', displayName: 'Meta Earth' })
    expect(arg.update).toMatchObject({ withdrawnAt: null })
  })
  it("another user's token is a 404", async () => {
    m.aFindFirst.mockResolvedValue(null)
    expect((await consent()).statusCode).toBe(404)
    expect(m.inUpsert).not.toHaveBeenCalled()
  })
  it('a name alone is not enough: the network and contract are required', async () => {
    for (const o of [{ network: null }, { contractAddress: null }, { network: '', contractAddress: '' }]) {
      m.aFindFirst.mockResolvedValue(asset(o))
      const res = await consent()
      expect(res.statusCode).toBe(400)
      expect(res.json().error.message).toMatch(/network and contract/)
    }
    expect(m.inUpsert).not.toHaveBeenCalled()
  })
  it('a token that already mirrors a RupChain token cannot be suggested', async () => {
    m.aFindFirst.mockResolvedValue(asset({ ctmTokenId: 'tok1' }))
    expect((await consent()).statusCode).toBe(409)
  })
  it('a token already listed on the platform (same network + contract, any letter case) is refused', async () => {
    m.ctmFind.mockResolvedValue({ id: 'tok9' })
    expect((await consent()).statusCode).toBe(409)
    expect(m.ctmFind.mock.calls[0]![0].where).toEqual({
      contractAddress: { equals: '0xABCdef', mode: 'insensitive' },
      network: { equals: 'BEP20', mode: 'insensitive' },
    })
    expect(m.inUpsert).not.toHaveBeenCalled()
  })
  it('needs a verified, non-banned account (so a throwaway account cannot inflate a count)', async () => {
    m.userFind.mockResolvedValue({ isEmailVerified: false, isBanned: false })
    expect((await consent()).statusCode).toBe(403)
    m.userFind.mockResolvedValue({ isEmailVerified: true, isBanned: true })
    expect((await consent()).statusCode).toBe(403)
    m.userFind.mockResolvedValue(null)
    expect((await consent()).statusCode).toBe(403)
    expect(m.inUpsert).not.toHaveBeenCalled()
  })
  it('caps how many tokens one account can suggest, but re-confirming an active one is fine', async () => {
    m.inCount.mockResolvedValue(20)
    expect((await consent()).statusCode).toBe(400)
    m.inFindFirst.mockResolvedValue({ id: 'i1', withdrawnAt: null })
    expect((await consent()).statusCode).toBe(200)
  })
  it('suggesting again after withdrawing counts as new and is capped', async () => {
    m.inCount.mockResolvedValue(20)
    m.inFindFirst.mockResolvedValue({ id: 'i1', withdrawnAt: new Date() })
    expect((await consent()).statusCode).toBe(400)
    m.inCount.mockResolvedValue(3)
    expect((await consent()).statusCode).toBe(200)
  })
})

describe('withdrawing consent', () => {
  it('marks only the caller\'s active suggestion for that token as withdrawn', async () => {
    const res = await withdraw()
    expect(res.statusCode).toBe(200)
    expect(m.inUpdateMany.mock.calls[0]![0].where).toEqual({ assetId: 'a1', userId: 'u1', withdrawnAt: null })
    expect(m.inUpdateMany.mock.calls[0]![0].data.withdrawnAt).toBeInstanceOf(Date)
  })
  it('is a 404 when there is nothing to withdraw, and requires authentication', async () => {
    m.inUpdateMany.mockResolvedValue({ count: 0 })
    expect((await withdraw()).statusCode).toBe(404)
    expect((await withdraw('a1', {})).statusCode).toBe(401)
  })
})

describe('listing and editing', () => {
  it('the token list says which tokens the user has suggested, from the user\'s own rows only', async () => {
    m.aFindMany.mockResolvedValue([
      { id: 'a1', name: 'A', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date(), archivedAt: null },
      { id: 'a2', name: 'B', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date(), archivedAt: null },
    ])
    m.inFindMany.mockResolvedValue([{ assetId: 'a2' }])
    const d = (await app.inject({ method: 'GET', url: '/api/v1/portfolio/assets', headers: U })).json().data
    expect(d.map((a: { listingInterest: boolean }) => a.listingInterest)).toEqual([false, true])
    expect(m.inFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', withdrawnAt: null })
  })
  it('changing a token\'s network or contract withdraws consent that was given for the old identity', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 1 })
    m.aFindFirst.mockResolvedValue({ id: 'a1', name: 'X', symbol: null, sourceUrl: null, network: 'BEP20', contractAddress: '0xAB12', createdAt: new Date(), archivedAt: null })
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: U, payload: { name: 'X', network: 'BEP20', contractAddress: '0xAB12' } })
    expect(res.statusCode).toBe(200)
    expect(m.inUpdateMany.mock.calls[0]![0].where).toEqual({ assetId: 'a1', userId: 'u1', withdrawnAt: null, identityKey: { not: 'bep20:0xab12' } })
  })
  it('removing the identity entirely withdraws consent', async () => {
    m.aUpdateMany.mockResolvedValue({ count: 1 })
    m.aFindFirst.mockResolvedValue({ id: 'a1', name: 'X', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date(), archivedAt: null })
    await app.inject({ method: 'PATCH', url: '/api/v1/portfolio/assets/a1', headers: U, payload: { name: 'X' } })
    expect(m.inUpdateMany.mock.calls[0]![0].where).toEqual({ assetId: 'a1', userId: 'u1', withdrawnAt: null })
  })
})
