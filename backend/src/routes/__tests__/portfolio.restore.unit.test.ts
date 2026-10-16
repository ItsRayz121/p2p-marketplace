import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

// A plain function (not vi.fn) so a deliberately thrown error is not also recorded by the mock as a failure.
const m = vi.hoisted(() => {
  const calls: unknown[][] = []
  let impl: (...a: unknown[]) => unknown = () => undefined
  return { calls, set: (f: (...a: unknown[]) => unknown) => { impl = f }, reset: () => { calls.length = 0; impl = () => undefined }, fn: (...a: unknown[]) => { calls.push(a); return impl(...a) } }
})
// No tables at all: the route itself touches nothing; the (mocked) service is the only collaborator.
vi.mock('../../lib/prisma', () => ({ db: new Proxy({}, { get(_t, p: string) { throw new Error(`unexpected db access: ${p}`) } }) }))
vi.mock('../../services/portfolioRestore.service', () => ({ restorePortfolioBackup: m.fn }))
vi.mock('../../services/portfolioImport.service', () => ({ runCtmImport: vi.fn() }))
vi.mock('../../services/platformFlags.service', () => ({ getStringConfig: async () => '', getBoolConfig: async () => true }))
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
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message: 'unexpected' } })
})
await app.register(portfolioRoutes, { prefix: '/api/v1' })
afterAll(async () => { await app.close() })

const post = (payload: unknown, headers: Record<string, string> = { 'x-test-user': 'u1' }) =>
  app.inject({ method: 'POST', url: '/api/v1/portfolio/restore', headers, payload: payload as object })

beforeEach(() => m.reset())

describe('POST /portfolio/restore', () => {
  it('requires authentication and does nothing without it', async () => {
    expect((await post({ a: 1 }, {})).statusCode).toBe(401)
    expect(m.calls).toHaveLength(0)
  })
  it('restores for the signed-in user only: a user id inside the file is never used', async () => {
    m.set(async () => ({ assets: { created: 1, alreadyThere: 0 }, notes: [] }))
    const res = await post({ userId: 'victim', format: 'x' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.json().data.assets.created).toBe(1)
    expect(m.calls[0]![0]).toBe('u1')
    expect(m.calls[0]![1]).toMatchObject({ userId: 'victim' }) // only data to validate; the service ignores it
    expect(m.calls[0]![2]).toMatchObject({ maxAssets: 200, maxEvents: 5000 })
  })
  it('passes a rejected file through as a clear 400', async () => {
    m.set(() => { throw new AppError('VALIDATION_ERROR', 'This file is not a valid RupChain portfolio backup.', 400) })
    const res = await post({})
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/not a valid/)
  })
  it('a simultaneous change gives a retryable conflict, not a crash', async () => {
    m.set(() => { throw Object.assign(new Error('unique'), { code: 'P2002' }) })
    const res = await post({})
    expect(res.statusCode).toBe(409)
  })
  it('an unexpected failure says nothing was changed and leaks no internals', async () => {
    m.set(() => { throw new Error('connection to db-host-17 refused') })
    const res = await post({})
    expect(res.statusCode).toBe(500)
    expect(JSON.stringify(res.json())).not.toContain('db-host-17')
    expect(res.json().error.message).toMatch(/Nothing was changed/)
  })
})
