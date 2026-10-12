import { describe, it, expect } from 'vitest'
import {
  idempotencyKeyFor,
  normalizeIdempotencyKey,
  withInFlightLock,
  type IdempotencyRedis,
} from '../idempotency'

function fakeRedis(): IdempotencyRedis & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async set(key, value) {
      if (store.has(key)) return null // NX: already held
      store.set(key, value)
      return 'OK'
    },
    async del(key) {
      store.delete(key)
      return 1
    },
  }
}

describe('normalizeIdempotencyKey', () => {
  it('accepts UUIDs and trims whitespace', () => {
    expect(normalizeIdempotencyKey('  3f2b6c1e-9d4a-4c1b-8a55-0e1f2a3b4c5d ')).toBe(
      '3f2b6c1e-9d4a-4c1b-8a55-0e1f2a3b4c5d',
    )
  })
  it.each(['', '   ', 'a'.repeat(129), 'bad key', 'a/b', 'x\ny', '{"$ne":1}'])('rejects %j', (k) => {
    expect(() => normalizeIdempotencyKey(k)).toThrow()
  })
})

describe('idempotencyKeyFor', () => {
  it('is scoped per user so two accounts never share a cached response', () => {
    expect(idempotencyKeyFor('withdrawal', 'u1', 'k')).not.toBe(idempotencyKeyFor('withdrawal', 'u2', 'k'))
  })
})

describe('withInFlightLock', () => {
  it('lets only one of two concurrent calls with the same key run', async () => {
    const r = fakeRedis()
    let runs = 0
    const slow = () =>
      withInFlightLock(r, 'k', async () => {
        runs++
        await new Promise((res) => setTimeout(res, 20))
        return 'done'
      })
    const results = await Promise.allSettled([slow(), slow()])
    expect(runs).toBe(1)
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { statusCode?: number }).statusCode).toBe(409)
  })

  it('releases the lock after success and after failure', async () => {
    const r = fakeRedis()
    await withInFlightLock(r, 'k', async () => 1)
    expect(r.store.size).toBe(0)
    await expect(withInFlightLock(r, 'k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(r.store.size).toBe(0)
    await expect(withInFlightLock(r, 'k', async () => 2)).resolves.toBe(2)
  })
})
