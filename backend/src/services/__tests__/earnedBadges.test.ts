import { describe, it, expect } from 'vitest'
import { evaluateEarnedBadges } from '../earnedBadges.rules'

const base = { userId: 'u', createdAt: new Date(), kycApproved: false, completedTrades: 0, avgReleaseMinutes: null, disputesLost: 0 }
const none = { gasDelivered: 0, gasChains: 0, earlyMember: false, affiliateApproved: false }
const keys = (i: Partial<typeof base>, e: Partial<typeof none> = {}) =>
  evaluateEarnedBadges({ ...base, ...i }, { ...none, ...e }).map((b) => b.key)

describe('evaluateEarnedBadges', () => {
  it('awards nothing to a brand-new member', () => {
    expect(keys({})).toEqual([])
  })
  it('requires both KYC and 10 trades for Verified Trader', () => {
    expect(keys({ kycApproved: true, completedTrades: 9 })).not.toContain('verified_trader')
    expect(keys({ kycApproved: false, completedTrades: 50 })).not.toContain('verified_trader')
    expect(keys({ kycApproved: true, completedTrades: 10 })).toContain('verified_trader')
  })
  it('needs a known fast release time and 20+ trades for Fast Releaser', () => {
    expect(keys({ completedTrades: 20, avgReleaseMinutes: null })).not.toContain('fast_releaser')
    expect(keys({ completedTrades: 19, avgReleaseMinutes: 5 })).not.toContain('fast_releaser')
    expect(keys({ completedTrades: 20, avgReleaseMinutes: 11 })).not.toContain('fast_releaser')
    expect(keys({ completedTrades: 20, avgReleaseMinutes: 10 })).toContain('fast_releaser')
  })
  it('Clean Record needs 50 trades and zero lost disputes', () => {
    expect(keys({ completedTrades: 50, disputesLost: 1 })).not.toContain('zero_disputes')
    expect(keys({ completedTrades: 49 })).not.toContain('zero_disputes')
    expect(keys({ completedTrades: 50 })).toContain('zero_disputes')
  })
  it('awards gas, multi-chain, early member and affiliate badges from their own signals', () => {
    expect(keys({}, { gasDelivered: 5 })).toContain('gas_regular')
    expect(keys({}, { gasDelivered: 4 })).not.toContain('gas_regular')
    expect(keys({}, { gasChains: 3 })).toContain('multi_chain')
    expect(keys({}, { earlyMember: true })).toContain('early_member')
    expect(keys({}, { earlyMember: false })).not.toContain('early_member')
    expect(keys({}, { affiliateApproved: true })).toContain('affiliate')
  })
})
