import { describe, it, expect } from 'vitest'
import { usdtResumeDeadline, RELEASE_WINDOW_MIN, PAY_AFTER_CRYPTO_WINDOW_MIN } from '../trade.service'

describe('usdtResumeDeadline', () => {
  it('returns nothing for rungs governed by a different mechanism', () => {
    for (const takerFirst of [false, true]) {
      expect(usdtResumeDeadline(takerFirst, 'payment_pending')).toEqual({}) // expiresAt
      expect(usdtResumeDeadline(takerFirst, 'payment_uploaded')).toEqual({}) // 24h updatedAt staleness check
    }
  })

  it('classic: payment_confirmed means the seller owes crypto — short releaseDeadlineAt window', () => {
    const patch = usdtResumeDeadline(false, 'payment_confirmed')
    expect(patch.releaseDeadlineAt).toBeInstanceOf(Date)
    const minutesAhead = (patch.releaseDeadlineAt!.getTime() - Date.now()) / 60_000
    expect(minutesAhead).toBeGreaterThan(RELEASE_WINDOW_MIN - 1)
    expect(minutesAhead).toBeLessThanOrEqual(RELEASE_WINDOW_MIN)
  })

  it('taker-first: payment_confirmed means the buyer/maker owes fiat — longer releaseDeadlineAt window, not confirmDeadlineAt', () => {
    const patch = usdtResumeDeadline(true, 'payment_confirmed')
    expect(patch.releaseDeadlineAt).toBeInstanceOf(Date)
    expect(patch.confirmDeadlineAt).toBeUndefined()
    const minutesAhead = (patch.releaseDeadlineAt!.getTime() - Date.now()) / 60_000
    expect(minutesAhead).toBeGreaterThan(PAY_AFTER_CRYPTO_WINDOW_MIN - 1)
    expect(minutesAhead).toBeLessThanOrEqual(PAY_AFTER_CRYPTO_WINDOW_MIN)
  })

  it('crypto_sent always means a pending terminal confirm — confirmDeadlineAt regardless of flow', () => {
    for (const takerFirst of [false, true]) {
      const patch = usdtResumeDeadline(takerFirst, 'crypto_sent')
      expect(patch.confirmDeadlineAt).toBeInstanceOf(Date)
      expect(patch.releaseDeadlineAt).toBeUndefined()
      expect(patch.confirmDeadlineAt!.getTime()).toBeGreaterThan(Date.now())
    }
  })
})
