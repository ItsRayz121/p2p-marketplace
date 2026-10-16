import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const m = vi.hoisted(() => ({ groupBy: vi.fn(), audit: vi.fn(), cfg: vi.fn() }))

// Only groupBy exists on the interest table: any attempt to read individual rows throws.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    portfolioListingInterest: { groupBy: m.groupBy },
    auditLog: { create: m.audit },
  }, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } }),
}))
vi.mock('../../services/platformFlags.service', () => ({ getNumberConfig: m.cfg }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: async (req: { headers: Record<string, string | undefined>; user?: { id: string; role: string } }) => {
    const id = req.headers['x-test-user']
    if (!id) { const { AppError } = await import('../../lib/errors'); throw new AppError('UNAUTHORIZED', 'Authentication required', 401) }
    req.user = { id, role: req.headers['x-test-role'] ?? 'user' }
  },
  requireRole: (...roles: string[]) => async (req: { user?: { role: string } }) => {
    if (!req.user || !roles.includes(req.user.role)) { const { AppError } = await import('../../lib/errors'); throw new AppError('FORBIDDEN', 'No permission', 403) }
  },
}))

import { portfolioAdminRoutes, resetInterestSnapshot } from '../portfolioAdmin.routes'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
await app.register(portfolioAdminRoutes, { prefix: '/api/v1/admin' })
afterAll(async () => { await app.close() })

const ADMIN = { 'x-test-user': 'adm1', 'x-test-role': 'admin' }
const get = (headers: Record<string, string> = ADMIN) => app.inject({ method: 'GET', url: '/api/v1/admin/portfolio/interest', headers })
const cnt = (identityKey: string, n: number, extra: Record<string, unknown> = {}) => ({ identityKey, _count: { _all: n }, ...extra })

function wire(totals: ReturnType<typeof cnt>[], opts: { recent?: ReturnType<typeof cnt>[]; previous?: ReturnType<typeof cnt>[]; names?: ReturnType<typeof cnt>[] } = {}) {
  m.groupBy.mockImplementation(async (arg: { by: string[]; where: { consentedAt?: { gte: Date; lt?: Date } } }) => {
    if (arg.by.length === 2) return opts.names ?? []
    if (arg.where.consentedAt?.lt) return opts.previous ?? []
    if (arg.where.consentedAt) return opts.recent ?? []
    return totals
  })
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  resetInterestSnapshot()
  m.cfg.mockResolvedValue(20)
  m.audit.mockResolvedValue({})
})

describe('access control', () => {
  it('requires authentication and an admin role', async () => {
    expect((await get({})).statusCode).toBe(401)
    expect((await get({ 'x-test-user': 'u1', 'x-test-role': 'user' })).statusCode).toBe(403)
    expect((await get({ 'x-test-user': 'u1', 'x-test-role': 'support_agent' })).statusCode).toBe(403)
    expect((await get({ 'x-test-user': 'u1', 'x-test-role': 'merchant' })).statusCode).toBe(403)
    expect(m.groupBy).not.toHaveBeenCalled()
  })
  it('admin and super_admin may view the aggregate', async () => {
    wire([])
    expect((await get()).statusCode).toBe(200)
    resetInterestSnapshot()
    expect((await get({ 'x-test-user': 's1', 'x-test-role': 'super_admin' })).statusCode).toBe(200)
  })
})

describe('what an admin sees', () => {
  it('only groups at or above the threshold, with rounded-down counts and no individual data', async () => {
    wire(
      [cnt('bep20:0xbig', 33), cnt('bep20:0xsmall', 7), cnt('bep20:0xedge', 20)],
      { recent: [cnt('bep20:0xbig', 12)], previous: [cnt('bep20:0xbig', 3)], names: [cnt('bep20:0xbig', 31, { displayName: 'Meta Earth' }), cnt('bep20:0xbig', 2, { displayName: 'my private label' })] },
    )
    const res = await get()
    const d = res.json().data
    expect(d.threshold).toBe(20)
    expect(d.groups.map((g: { contract: string }) => g.contract)).toEqual(['0xbig', '0xedge'])
    expect(d.groups[0]).toEqual({ network: 'bep20', contract: '0xbig', approxAccounts: 30, commonName: 'Meta Earth', trend: 'rising' })
    expect(d.suppressedGroups).toBe(1)
    const text = res.body
    for (const leak of ['0xsmall', 'my private label', 'userId', 'u1']) expect(text).not.toContain(leak)
    expect(d.notice).toMatch(/does not approve a listing/)
  })
  it('counts only active (not withdrawn) consents and never reads individual rows', async () => {
    wire([cnt('bep20:0xa', 25)])
    await get()
    for (const call of m.groupBy.mock.calls) expect(call[0].where.withdrawnAt).toBeNull()
    // the finer queries run only for groups big enough to be shown
    const keyed = m.groupBy.mock.calls.filter((c) => c[0].where.identityKey)
    for (const c of keyed) expect(c[0].where.identityKey.in).toEqual(['bep20:0xa'])
  })
  it('does not even examine groups below the threshold in detail', async () => {
    wire([cnt('bep20:0xa', 5)])
    await get()
    expect(m.groupBy).toHaveBeenCalledTimes(1) // just the totals
  })
  it('the threshold cannot be configured below the floor of 10', async () => {
    m.cfg.mockResolvedValue(1)
    wire([cnt('bep20:0xa', 9), cnt('bep20:0xb', 10)])
    const d = (await get()).json().data
    expect(d.threshold).toBe(10)
    expect(d.groups.map((g: { contract: string }) => g.contract)).toEqual(['0xb'])
  })
  it('an empty result is a valid empty report', async () => {
    wire([])
    const d = (await get()).json().data
    expect(d).toMatchObject({ groups: [], suppressedGroups: 0 })
  })
})

describe('differencing protection and audit', () => {
  it('serves a snapshot for an hour: repeated requests do not re-query, so joins cannot be watched in real time', async () => {
    wire([cnt('bep20:0xa', 25)])
    const first = (await get()).json().data
    wire([cnt('bep20:0xa', 40)]) // data changes underneath
    const second = (await get()).json().data
    expect(second.groups[0].approxAccounts).toBe(first.groups[0].approxAccounts)
    expect(second.asOf).toBe(first.asOf)
    expect(m.groupBy).toHaveBeenCalledTimes(1 + 3) // totals + (recent, previous, names) once
  })
  it('every view is written to the audit log with who looked, never what any user did', async () => {
    wire([cnt('bep20:0xa', 25)])
    await get()
    await get()
    expect(m.audit).toHaveBeenCalledTimes(2)
    const data = m.audit.mock.calls[0]![0].data
    expect(data).toMatchObject({ actorId: 'adm1', action: 'PORTFOLIO_INTEREST_VIEW', targetType: 'PortfolioListingInterest' })
    expect(JSON.stringify(data.metadata)).not.toContain('0xa')
  })
  it('a failed audit write does not break the view or leak anything', async () => {
    wire([])
    m.audit.mockRejectedValue(new Error('db down'))
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('db down')
  })
  it('is private and uncached', async () => {
    wire([])
    expect((await get()).headers['cache-control']).toBe('private, no-store')
  })
})
