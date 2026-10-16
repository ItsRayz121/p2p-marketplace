import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({ aFindMany: vi.fn(), evFindMany: vi.fn(), prFindMany: vi.fn() }))
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioAsset: { findMany: m.aFindMany },
    portfolioEvent: { findMany: m.evFindMany },
    portfolioPriceObservation: { findMany: m.prFindMany },
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
// The browser's backup reader/writer: what the server exports must be something it accepts.
import { buildBackup, parseBackup, buildCsv } from '../../../../frontend/src/lib/portfolio/exportFile'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const dec = (s: string) => new Prisma.Decimal(s)
const get = (headers: Record<string, string> = { 'x-test-user': 'u1' }) => app.inject({ method: 'GET', url: '/api/v1/portfolio/export', headers })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.aFindMany.mockResolvedValue([
    { id: 'a1', name: 'Meta Earth', symbol: 'MEC', sourceUrl: null, network: null, contractAddress: null, createdAt: new Date('2026-01-01'), archivedAt: new Date('2026-09-01'), ctmTokenId: 'tok1' },
    { id: 'a2', name: 'Mine', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: new Date('2026-01-02'), archivedAt: null, ctmTokenId: null },
  ])
  m.evFindMany.mockResolvedValue([{
    id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: new Date('2026-01-02'), quantity: dec('1'), consideration: dec('10'), fee: dec('0'),
    basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: 'hi', createdAt: new Date('2026-01-02'),
    source: 'ctm', voidedAt: new Date('2026-02-01'), voidReason: 'disputed',
  }])
  m.prFindMany.mockResolvedValue([{ assetId: 'a1', price: dec('2'), quote: 'USDT', observedAt: new Date('2026-01-03') }])
})

describe('GET /portfolio/export', () => {
  it('requires authentication', async () => {
    expect((await get({})).statusCode).toBe(401)
    expect(m.aFindMany).not.toHaveBeenCalled()
  })
  it('exports only the caller\'s data, private and uncached', async () => {
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    for (const f of [m.aFindMany, m.evFindMany, m.prFindMany]) expect(f.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
  })
  it('includes archived tokens and voided entries (flagged) so a backup is complete', async () => {
    const d = (await get()).json().data
    expect(d.assets.map((a: { id: string }) => a.id)).toEqual(['a1', 'a2'])
    expect(d.assets[0]).toMatchObject({ archivedAt: '2026-09-01T00:00:00.000Z', linkedToRupChainToken: true })
    expect(d.assets[1].linkedToRupChainToken).toBe(false)
    expect(d.events[0]).toMatchObject({ source: 'ctm', voided: true, voidReason: 'disputed', quote: 'PKR' })
    expect(d.prices[0]).toEqual({ assetId: 'a1', price: '2', quote: 'USDT', observedAt: '2026-01-03T00:00:00.000Z' })
  })
  it('decimals are strings and no owner or source-system id leaks', async () => {
    const d = (await get()).json().data
    expect(typeof d.events[0].quantity).toBe('string')
    const text = JSON.stringify(d)
    for (const secret of ['userId', 'sourceRef', 'ctmTokenId', 'tok1', 'u1']) expect(text).not.toContain(secret)
  })

  it('CONTRACT: what the server exports can be saved as a backup and read straight back by the app', async () => {
    const data = (await get()).json().data
    const file = buildBackup(data)
    const back = parseBackup(file)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.data.assets.map((a) => a.id)).toEqual(['a1', 'a2'])
      expect(back.data.events[0]).toMatchObject({ id: 'e1', source: 'ctm', voided: true })
    }
  })
  it('CONTRACT: the same export produces a CSV without errors', async () => {
    const data = (await get()).json().data
    expect(buildCsv(data).split('\r\n')[1]).toContain('Meta Earth')
  })
})
