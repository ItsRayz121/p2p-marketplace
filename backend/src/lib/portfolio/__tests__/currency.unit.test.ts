import { describe, it, expect } from 'vitest'
import { cleanRate, convertAmount, chooseFxStamp, PLATFORM_RATE_WINDOW_MS } from '../currency'

describe('cleanRate', () => {
  it('accepts plain positive decimals', () => {
    expect(cleanRate('280')).toBe('280')
    expect(cleanRate(' 281.45 ')).toBe('281.45')
  })
  it.each([[''], ['0'], ['0.00'], ['-5'], ['abc'], ['1e3'], ['NaN'], [null], [undefined], ['1,5']])('rejects %j as unavailable', (v) => {
    expect(cleanRate(v as string)).toBeNull()
  })
})

describe('convertAmount', () => {
  it('same currency is exact and needs no rate', () => {
    expect(convertAmount('123.456', 'PKR', 'PKR', null)).toBe('123.456')
    expect(convertAmount('5', 'USDT', 'USDT', undefined)).toBe('5')
  })
  it('USDT -> PKR multiplies, PKR -> USDT divides, both by the given rate', () => {
    expect(convertAmount('400', 'USDT', 'PKR', '278')).toBe('111200')
    expect(convertAmount('111200', 'PKR', 'USDT', '278')).toBe('400')
  })
  it('rounds half-even to 8 places and never uses floats', () => {
    expect(convertAmount('1', 'PKR', 'USDT', '3')).toBe('0.33333333')
    expect(convertAmount('0.1', 'USDT', 'PKR', '3')).toBe('0.3')
  })
  it('a missing, zero or malformed rate is unavailable (null), never zero and never another rate', () => {
    for (const r of [null, undefined, '', '0', '-1', 'abc']) {
      expect(convertAmount('100', 'PKR', 'USDT', r)).toBeNull()
      expect(convertAmount('100', 'USDT', 'PKR', r)).toBeNull()
    }
  })
  it('a result too large to store is unavailable rather than wrong', () => {
    expect(convertAmount('9999999999999999999999999999', 'USDT', 'PKR', '1000')).toBeNull()
  })
})

describe('chooseFxStamp (history is never rebuilt at today\'s rate)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  it('a user-entered rate always wins and is marked manual', () => {
    expect(chooseFxStamp({ userRate: '275', platformRate: '280', occurredAtMs: now - 5 * PLATFORM_RATE_WINDOW_MS, nowMs: now }))
      .toEqual({ fxRate: '275', fxSource: 'manual' })
  })
  it('a record dated now is stamped with the platform rate', () => {
    expect(chooseFxStamp({ userRate: null, platformRate: '280.5', occurredAtMs: now - 3600_000, nowMs: now }))
      .toEqual({ fxRate: '280.5', fxSource: 'platform' })
  })
  it('an old record gets NO rate when the user gave none', () => {
    expect(chooseFxStamp({ userRate: null, platformRate: '280', occurredAtMs: now - 2 * PLATFORM_RATE_WINDOW_MS, nowMs: now }))
      .toEqual({ fxRate: null, fxSource: null })
  })
  it('no platform rate and no user rate stores nothing', () => {
    expect(chooseFxStamp({ userRate: undefined, platformRate: '0', occurredAtMs: now, nowMs: now })).toEqual({ fxRate: null, fxSource: null })
  })
  it('an invalid user rate is ignored, not trusted', () => {
    expect(chooseFxStamp({ userRate: '-3', platformRate: '280', occurredAtMs: now, nowMs: now }).fxSource).toBe('platform')
  })
})
