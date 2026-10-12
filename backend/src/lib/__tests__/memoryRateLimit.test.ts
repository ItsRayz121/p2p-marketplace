import { describe, it, expect } from 'vitest'
import { MemoryRateLimiter, fallbackBudget, FALLBACK_LIMITS } from '../memoryRateLimit'

describe('MemoryRateLimiter', () => {
  it('allows up to max then blocks with a retry-after', () => {
    const l = new MemoryRateLimiter(60_000)
    for (let i = 0; i < 3; i++) expect(l.hit('k', 3, 1_000).allowed).toBe(true)
    const blocked = l.hit('k', 3, 1_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })
  it('resets after the window', () => {
    const l = new MemoryRateLimiter(60_000)
    for (let i = 0; i < 4; i++) l.hit('k', 3, 0)
    expect(l.hit('k', 3, 60_001).allowed).toBe(true)
  })
  it('keeps keys independent', () => {
    const l = new MemoryRateLimiter(60_000)
    l.hit('a', 1, 0)
    expect(l.hit('a', 1, 0).allowed).toBe(false)
    expect(l.hit('b', 1, 0).allowed).toBe(true)
  })
  it('stays bounded under a flood of distinct keys', () => {
    const l = new MemoryRateLimiter(60_000)
    for (let i = 0; i < 60_000; i++) l.hit('k' + i, 5, 0)
    expect(l.size).toBeLessThanOrEqual(50_000)
  })
})

describe('fallbackBudget', () => {
  it.each([
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/auth/forgot-password'],
    ['POST', '/api/v1/wallet/withdraw'],
    ['POST', '/api/v1/gas-fee/orders/crypto'],
    ['POST', '/api/v1/upload/presign'],
    ['POST', '/api/v1/admin/users/1/ban'],
  ])('%s %s is the strict class', (m, p) => {
    expect(fallbackBudget(m, p)).toEqual({ cls: 's', max: FALLBACK_LIMITS.sensitive })
  })
  it('treats other writes and reads with their own budgets', () => {
    expect(fallbackBudget('POST', '/api/v1/trades').cls).toBe('w')
    expect(fallbackBudget('GET', '/api/v1/trades').cls).toBe('r')
    expect(fallbackBudget('GET', '/api/v1/wallet/withdraw').cls).toBe('r')
  })
})
