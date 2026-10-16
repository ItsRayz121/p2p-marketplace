import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const m = vi.hoisted(() => ({ str: vi.fn() }))

// Any database access throws: when the feature is off, NOTHING may be read or written.
vi.mock('../../lib/prisma', () => ({ db: new Proxy({}, { get(_t, p: string) { throw new Error(`unexpected db access: ${p}`) } }) }))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: m.str, getBoolConfig: vi.fn() }))
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
import { isPortfolioEnabled, resetPortfolioFlagCache, PORTFOLIO_FLAG_KEY } from '../../lib/portfolio/flag'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
// A route OUTSIDE the portfolio plugin, standing in for the wallet, trading and everything else.
app.get('/api/v1/wallet/balances', async () => ({ success: true, data: 'wallet still works' }))
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const U = { 'x-test-user': 'u1' }
const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, headers: Record<string, string> = U, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers, ...(payload ? { payload } : {}) })

beforeEach(() => { m.str.mockReset(); resetPortfolioFlagCache(); m.str.mockResolvedValue('true') })

describe('the flag itself', () => {
  it('is read from PlatformConfig "portfolio_enabled" and ON by default when the key is missing', async () => {
    expect(await isPortfolioEnabled()).toBe(true)
    expect(m.str).toHaveBeenCalledWith(PORTFOLIO_FLAG_KEY, '')
    expect(PORTFOLIO_FLAG_KEY).toBe('portfolio_enabled')
  })
  it.each(['True', 'TRUE', ' true ', 'yes', 'on', 'enabled', '', 'banana'])('value %j leaves it ON', async (v) => {
    m.str.mockResolvedValue(v)
    expect(await isPortfolioEnabled()).toBe(true)
  })
  it.each(['false', 'FALSE', ' False ', '0', 'off', 'no', 'disabled'])('value %j turns it OFF', async (v) => {
    m.str.mockResolvedValue(v)
    expect(await isPortfolioEnabled()).toBe(false)
  })
  it('only an explicit off turns it off', async () => {
    m.str.mockResolvedValue('false')
    expect(await isPortfolioEnabled()).toBe(false)
  })
  it('is cached briefly, then re-read, so a change takes effect within seconds', async () => {
    const t0 = 1_000_000
    await isPortfolioEnabled(t0)
    await isPortfolioEnabled(t0 + 5_000)
    expect(m.str).toHaveBeenCalledTimes(1)
    m.str.mockResolvedValue('false')
    expect(await isPortfolioEnabled(t0 + 16_000)).toBe(false)
    expect(m.str).toHaveBeenCalledTimes(2)
  })
  it('if the setting cannot be read it keeps the last known value, and defaults to on', async () => {
    m.str.mockRejectedValue(new Error('db down'))
    expect(await isPortfolioEnabled(1)).toBe(true)
    resetPortfolioFlagCache()
    m.str.mockResolvedValue('false')
    expect(await isPortfolioEnabled(2)).toBe(false)
    m.str.mockRejectedValue(new Error('db down'))
    expect(await isPortfolioEnabled(100_000)).toBe(false) // did not flip back on by accident
  })
})

describe('when the feature is switched off', () => {
  beforeEach(() => { m.str.mockResolvedValue('false') })

  it.each([
    ['GET', '/portfolio/assets'], ['POST', '/portfolio/assets'], ['GET', '/portfolio/summary'], ['GET', '/portfolio/performance'],
    ['GET', '/portfolio/export'], ['POST', '/portfolio/import/ctm'], ['GET', '/portfolio/assets/a1/events'],
    ['POST', '/portfolio/assets/a1/events'], ['POST', '/portfolio/assets/a1/price'], ['DELETE', '/portfolio/assets/a1'],
    ['POST', '/portfolio/assets/a1/archive'], ['POST', '/portfolio/assets/a1/interest'],
  ] as const)('%s %s answers "not available" and touches nothing', async (method, url) => {
    const res = await call(method, url, U, method === 'POST' ? {} : undefined)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('PORTFOLIO_DISABLED')
    // The strict database mock would have thrown (500) if anything had been read or written.
  })
  it('unauthenticated callers get the same answer, so nothing about the feature leaks', async () => {
    const res = await call('GET', '/portfolio/assets', {})
    expect(res.statusCode).toBe(404)
  })
  it('the status route still answers, so the app can hide the feature', async () => {
    const res = await call('GET', '/portfolio/status')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ enabled: false })
  })
  it('the status route still requires a signed-in user', async () => {
    expect((await call('GET', '/portfolio/status', {})).statusCode).toBe(401)
  })
  it('the wallet and everything outside the portfolio is completely unaffected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/wallet/balances' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toBe('wallet still works')
  })
  it('turning it back on restores access (nothing was deleted)', async () => {
    expect((await call('GET', '/portfolio/status')).json().data.enabled).toBe(false)
    m.str.mockResolvedValue('true')
    resetPortfolioFlagCache()
    expect((await call('GET', '/portfolio/status')).json().data.enabled).toBe(true)
  })
})

describe('when the feature is on', () => {
  it('reports enabled', async () => {
    expect((await call('GET', '/portfolio/status')).json().data).toEqual({ enabled: true })
  })
  it('the admin aggregate does not depend on the user-facing flag (source check)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../portfolioAdmin.routes.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('isPortfolioEnabled')
  })
})
