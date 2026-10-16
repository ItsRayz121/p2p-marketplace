import { describe, it, expect } from 'vitest'
import { priceAge, priceSourceLabel, STALE_AFTER_DAYS } from '@/lib/portfolio/priceStatus'

const now = new Date('2026-10-16T12:00:00Z')
describe('priceAge', () => {
  it('labels today and yesterday', () => {
    expect(priceAge('2026-10-16T01:00:00Z', now)).toEqual({ days: 0, stale: false, label: 'today' })
    expect(priceAge('2026-10-15T01:00:00Z', now)?.label).toBe('yesterday')
  })
  it('is stale from the threshold on, not before', () => {
    expect(priceAge(new Date(now.getTime() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString(), now)?.stale).toBe(false)
    expect(priceAge(new Date(now.getTime() - STALE_AFTER_DAYS * 86_400_000).toISOString(), now)?.stale).toBe(true)
  })
  it('never goes negative for a clock-skewed future time and rejects garbage', () => {
    expect(priceAge('2026-10-17T00:00:00Z', now)?.days).toBe(0)
    expect(priceAge('not a date', now)).toBeNull()
  })
})
describe('priceSourceLabel', () => {
  it('knows the platform and manual sources and falls back safely', () => {
    expect(priceSourceLabel('platform')).toBe('Latest RupChain trade')
    expect(priceSourceLabel(undefined)).toBe('Price you entered')
    expect(priceSourceLabel('weird')).toBe('Price you entered')
  })
})
