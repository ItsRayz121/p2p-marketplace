import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({ evFindMany: vi.fn(), prFindMany: vi.fn(), cfg: vi.fn() }))

vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioEvent: { findMany: m.evFindMany },
    portfolioPriceObservation: { findMany: m.prFindMany },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.cfg, getBoolConfig: async () => true }))
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
const get = (qs = '', headers: Record<string, string> = U) => app.inject({ method: 'GET', url: `/api/v1/portfolio/performance${qs}`, headers })
const row = (o: Record<string, unknown>) => ({
  id: 'e', assetId: 'MEC', type: 'BUY', occurredAt: new Date('2026-01-01T00:00:00Z'), quantity: dec('100'), consideration: dec('100000'),
  fee: dec('1000'), basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, createdAt: new Date(),
  source: 'manual', voidedAt: null, voidReason: null, ...o,
})
const stored = () => [
  row({ id: 'e1' }),
  row({ id: 'e2', type: 'SELL', occurredAt: new Date('2026-01-10T00:00:00Z'), quantity: dec('40'), consideration: dec('52000'), fee: dec('400') }),
]

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.evFindMany.mockResolvedValue(stored())
  m.prFindMany.mockResolvedValue([])
  m.cfg.mockResolvedValue('')
})

describe('GET /portfolio/performance', () => {
  it('requires authentication and is private/no-store', async () => {
    expect((await get('', {})).statusCode).toBe(401)
    const ok = await get('?from=2026-01-01T00:00:00Z&to=2026-01-20T00:00:00Z')
    expect(ok.headers['cache-control']).toBe('private, no-store')
  })
  it('reads only the caller\'s records', async () => {
    await get('?from=2026-01-01T00:00:00Z&to=2026-01-20T00:00:00Z')
    expect(m.evFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1', voidedAt: null })
    expect(m.prFindMany.mock.calls[0]![0].where).toEqual({ userId: 'u1' })
  })
  it('returns the series and period results for the spec fixture, as strings', async () => {
    const res = await get('?from=2026-01-05T00:00:00Z&to=2026-01-20T00:00:00Z')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.currency).toBe('PKR')
    expect(d.points.length).toBeGreaterThan(2)
    expect(d.points.at(-1)).toMatchObject({ costBasis: '60600', realized: '11200', value: null })
    expect(d.period).toMatchObject({ realized: '11200', moneyIn: '0', moneyOut: '51600', gain: null, returnPct: null })
    expect(d.period.gainUnavailableReason).toMatch(/price is missing/)
  })
  it('defaults to "all time" starting at the first entry', async () => {
    const d = (await get('?to=2026-01-20T00:00:00Z')).json().data
    expect(d.from).toBe('2026-01-01T00:00:00.000Z')
  })
  it('values the last point with the current platform rate when it is "now"', async () => {
    m.prFindMany.mockResolvedValue([{ assetId: 'MEC', price: dec('4'), quote: 'USDT', observedAt: new Date('2026-01-15T00:00:00Z') }])
    m.cfg.mockResolvedValue('300')
    const d = (await get('?from=2026-01-01T00:00:00Z')).json().data
    // 60 units x (4 USDT x 300) = 72,000 PKR at today's rate; history before "now" stays a gap
    expect(d.points.at(-1).value).toBe('72000')
    expect(d.points[0].value).toBeNull()
  })
  it('supports USDT, listing tokens that have no recorded rate', async () => {
    m.evFindMany.mockResolvedValue([row({ id: 'x', assetId: 'OLD', fxRate: null })])
    const d = (await get('?currency=USDT&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z')).json().data
    expect(d.fxUnavailableAssets).toEqual(['OLD'])
  })
  it.each([
    ['unknown currency', '?currency=EUR'], ['bad date', '?from=yesterday'], ['date only', '?from=2026-01-01'],
    ['inverted range', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
    ['absurdly long range', '?from=1990-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'],
  ])('rejects %s', async (_l, qs) => {
    expect((await get(qs)).statusCode).toBe(400)
  })
  it('does not leak internals on corrupt data', async () => {
    m.evFindMany.mockResolvedValue([row({ quantity: dec('-1') })])
    const res = await get('?from=2026-01-01T00:00:00Z&to=2026-01-20T00:00:00Z')
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('PORTFOLIO_CALC_FAILED')
  })
  it('an empty portfolio gives a valid empty series', async () => {
    m.evFindMany.mockResolvedValue([])
    const d = (await get()).json().data
    expect(d.points.every((p: { held: number }) => p.held === 0)).toBe(true)
    expect(d.period.gain).not.toBeUndefined()
  })
})
