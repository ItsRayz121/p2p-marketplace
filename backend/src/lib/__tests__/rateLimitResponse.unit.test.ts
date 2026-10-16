import { describe, it, expect, afterAll } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { rateLimitErrorResponse } from '../rateLimitResponse'

const build = async (errorResponseBuilder: (req: never, ctx: never) => object) => {
  const app = Fastify()
  await app.register(rateLimit, { global: true, max: 1, timeWindow: '1 minute', errorResponseBuilder: errorResponseBuilder as never })
  app.get('/x', async () => ({ ok: true }))
  await app.ready()
  return app
}

const apps: Array<{ close: () => Promise<unknown> }> = []
afterAll(async () => { for (const a of apps) await a.close() })

describe('rate limit response', () => {
  it('answers 429 (not 500) with the documented body and a Retry-After header once the limit is passed', async () => {
    const app = await build(rateLimitErrorResponse as never); apps.push(app)
    expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    expect(res.json()).toMatchObject({ success: false, error: 'TOO_MANY_REQUESTS', message: expect.stringMatching(/Rate limit exceeded/) })
  })

  it('CONTRAST: the old body without a status code came back as a 500', async () => {
    const old = (_req: unknown, ctx: { after: string; ttl: number }) => ({ success: false, error: 'TOO_MANY_REQUESTS', message: `Rate limit exceeded. Retry after ${ctx.after}.`, retryAfter: ctx.ttl })
    const app = await build(old as never); apps.push(app)
    await app.inject({ method: 'GET', url: '/x' })
    expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(500)
  })

  it('the builder carries the status code and the remaining wait', () => {
    expect(rateLimitErrorResponse({}, { after: '1 minute', ttl: 42_000 })).toEqual({
      statusCode: 429, success: false, error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Retry after 1 minute.', retryAfter: 42_000,
    })
  })
})
