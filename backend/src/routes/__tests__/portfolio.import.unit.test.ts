import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const m = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../services/portfolioImport.service', () => ({ runCtmImport: m.run }))
vi.mock('../../lib/prisma', () => ({ db: new Proxy({}, { get(_t, p: string) { throw new Error(`unexpected db access: ${p}`) } }) }))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: async () => '', getBoolConfig: async () => true }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: async (req: { headers: Record<string, string | undefined>; user?: { id: string } }) => {
    const id = req.headers['x-test-user']
    if (!id) { const { AppError } = await import('../../lib/errors'); throw new AppError('UNAUTHORIZED', 'Authentication required', 401) }
    req.user = { id }
  },
}))

import { portfolioRoutes, MAX_PORTFOLIO_ASSETS, MAX_PORTFOLIO_EVENTS } from '../portfolio.routes'
import { AppError } from '../../lib/errors'

const app = Fastify()
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) return reply.code(err.statusCode).send({ success: false, error: { code: err.code, message: err.message } })
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: String(err) } })
})
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const post = (payload?: unknown, headers: Record<string, string> = { 'x-test-user': 'u1' }) =>
  app.inject({ method: 'POST', url: '/api/v1/portfolio/import/ctm', headers, ...(payload !== undefined ? { payload: payload as object } : {}) })
const report = { dryRun: false, created: 2, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: true, preview: [], skippedForLimit: 0 }

beforeEach(() => { m.run.mockReset(); m.run.mockResolvedValue(report) })

describe('POST /portfolio/import/ctm', () => {
  it('requires authentication', async () => {
    expect((await post({}, {})).statusCode).toBe(401)
    expect(m.run).not.toHaveBeenCalled()
  })
  it('imports for the authenticated user only, with the per-user limits', async () => {
    const res = await post({})
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ created: 2 })
    expect(m.run).toHaveBeenCalledWith('u1', { dryRun: false, maxAssets: MAX_PORTFOLIO_ASSETS, maxEvents: MAX_PORTFOLIO_EVENTS })
    expect(res.headers['cache-control']).toBe('private, no-store')
  })
  it('an empty body is fine; dryRun is passed through', async () => {
    expect((await post()).statusCode).toBe(200)
    await post({ dryRun: true })
    expect(m.run).toHaveBeenLastCalledWith('u1', expect.objectContaining({ dryRun: true }))
  })
  it('cannot be pointed at another user: a user id in the body is rejected', async () => {
    const res = await post({ userId: 'victim' })
    expect(res.statusCode).toBe(400)
    expect(m.run).not.toHaveBeenCalled()
  })
  it('rejects a non-boolean dryRun', async () => {
    expect((await post({ dryRun: 'yes' })).statusCode).toBe(400)
  })
  it('hides internal errors behind a generic message', async () => {
    m.run.mockRejectedValue(new Error('connection to ctmTrade table failed at 10.0.0.5'))
    const res = await post({})
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('PORTFOLIO_IMPORT_FAILED')
    expect(res.body).not.toMatch(/10\.0\.0\.5|ctmTrade/)
  })
})
