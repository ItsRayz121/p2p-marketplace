import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), redisPing: vi.fn() }))

vi.mock('../../lib/prisma', () => ({ db: { $queryRaw: mocks.queryRaw } }))
vi.mock('../../lib/redis', () => ({ redis: { ping: mocks.redisPing } }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../lib/resend', () => ({ EMAIL_FROM: null, isEmailConfigured: () => false }))

import { healthRoutes, resetReadinessCache } from '../health.routes'

const app = Fastify()
await app.register(healthRoutes)

afterAll(async () => { await app.close() })

describe('GET /health/ready', () => {
  beforeEach(() => { resetReadinessCache(); mocks.queryRaw.mockReset(); mocks.redisPing.mockReset(); mocks.redisPing.mockResolvedValue('PONG') })

  it('is ready only when the database answers', async () => {
    mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }])
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ready: true })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers 503 DATABASE_UNAVAILABLE when the database fails, while /health/ping still says pong', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connection refused'))
    const ready = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toMatchObject({ ready: false, error: 'DATABASE_UNAVAILABLE' })

    // The liveness ping does not touch the DB, which is exactly why it is not recovery evidence.
    const ping = await app.inject({ method: 'GET', url: '/health/ping' })
    expect(ping.statusCode).toBe(200)
  })

  it('times out a hung database query instead of hanging the request', async () => {
    vi.useFakeTimers()
    try {
      mocks.queryRaw.mockReturnValue(new Promise(() => { /* never settles */ }))
      const pending = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(5_000)
      const res = await pending
      expect(res.statusCode).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stack a new DB query on top of one that is still hung', async () => {
    vi.useFakeTimers()
    try {
      mocks.queryRaw.mockReturnValue(new Promise(() => { /* never settles */ }))
      for (let i = 0; i < 3; i++) {
        const pending = app.inject({ method: 'GET', url: '/health/ready' })
        await vi.advanceTimersByTimeAsync(7_000) // past the timeout and the shared-result TTL
        expect((await pending).statusCode).toBe(503)
      }
      expect(mocks.queryRaw).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers once the database answers again after a probe that never settles', async () => {
    vi.useFakeTimers()
    try {
      mocks.queryRaw.mockReturnValueOnce(new Promise(() => { /* stuck forever */ }))
      const first = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await first).statusCode).toBe(503)

      // Database is back; the stuck probe is abandoned once it is old enough.
      mocks.queryRaw.mockResolvedValue([{ ok: 1 }])
      await vi.advanceTimersByTimeAsync(31_000)
      const later = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(10)
      expect((await later).statusCode).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers as soon as a slow probe finally succeeds', async () => {
    vi.useFakeTimers()
    try {
      let finish: (v: unknown) => void = () => {}
      mocks.queryRaw.mockReturnValueOnce(new Promise((r) => { finish = r }))
      const first = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await first).statusCode).toBe(503)
      finish([{ ok: 1 }]) // e.g. Neon finished waking up
      await vi.advanceTimersByTimeAsync(3_000) // past the shared-result TTL
      mocks.queryRaw.mockResolvedValue([{ ok: 1 }])
      const later = app.inject({ method: 'GET', url: '/health/ready' })
      await vi.advanceTimersByTimeAsync(10)
      expect((await later).statusCode).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /health answers within its deadline while the DB probe is stuck', async () => {
    vi.useFakeTimers()
    try {
      mocks.queryRaw.mockReturnValue(new Promise(() => { /* stuck */ }))
      const pending = app.inject({ method: 'GET', url: '/health' })
      await vi.advanceTimersByTimeAsync(6_000)
      const res = await pending
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'degraded' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('GET /health answers within its deadline while Redis is stuck', async () => {
    vi.useFakeTimers()
    try {
      mocks.queryRaw.mockResolvedValue([{ ok: 1 }])
      mocks.redisPing.mockReturnValue(new Promise(() => { /* stuck */ }))
      const pending = app.inject({ method: 'GET', url: '/health' })
      await vi.advanceTimersByTimeAsync(6_000)
      expect((await pending).statusCode).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one query between concurrent checks', async () => {
    mocks.queryRaw.mockResolvedValue([])
    await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: '/health/ready' })))
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1)
  })
})
