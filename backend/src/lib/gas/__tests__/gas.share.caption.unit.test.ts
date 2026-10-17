import { describe, it, expect, vi } from 'vitest'

vi.mock('../../prisma', () => ({ db: {} }))
vi.mock('../../env', () => ({ env: { FRONTEND_URL: 'https://rupchain.test' } }))
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../notify', () => ({ notify: vi.fn() }))
vi.mock('../../../services/adminNotification.service', () => ({ createAdminNotif: vi.fn() }))
vi.mock('../../../services/platformFlags.service', () => ({ getBoolConfig: vi.fn(), getNumberConfig: vi.fn(), isFlagEnabled: vi.fn(), FLAGS: {} }))
vi.mock('../gas.referral', () => ({ getOrCreateOwnCode: vi.fn() }))
vi.mock('../../social/xVerification', () => ({ verifyShareReward: vi.fn(), X_VERIFY_AUTO_APPROVE_KEY: 'k' }))

import { buildShareText, buildShareHashtags, tweetWeightedLength } from '../gas.share'

const base = { seed: 'GF-1:0', amount: '0.0001', symbol: 'BNB', chainName: 'BNB Smart Chain', chainKey: 'BSC', paidWith: 'USDT' as const, link: 'https://rupchain.com/s/GF-1?v=0', handle: 'RupChainHQ' }

describe('share caption', () => {
  it('mentions the configured handle, links the order, discloses the incentive and tags the chain', () => {
    const t = buildShareText(base)
    expect(t).toContain('@RupChainHQ')
    expect(t).toContain(base.link)
    expect(t).toMatch(/discount/i)
    expect(t).toMatch(/#RupChain #BNBGasFees #ad$/)
  })
  it('never guesses a handle and never claims a delivery time', () => {
    const t = buildShareText({ ...base, handle: null })
    expect(t).not.toContain('@')
    for (let v = 0; v < 12; v++) expect(buildShareText({ ...base, seed: `GF-1:${v}`, handle: null })).not.toMatch(/minutes|seconds/i)
  })
  it('states the real payment currency', () => {
    expect(buildShareText({ ...base, paidWith: 'PKR', seed: 'a' })).toContain('PKR')
    expect(buildShareText({ ...base, paidWith: 'PKR', seed: 'a' })).not.toContain('USDT')
  })
  it('stays within the X limit across seeds and long chain names', () => {
    for (let v = 0; v < 30; v++) {
      expect(tweetWeightedLength(buildShareText({ ...base, seed: `x:${v}`, chainName: 'Some Very Long Network Name Mainnet' }))).toBeLessThanOrEqual(280)
    }
  })
  it('hashtags follow the chain', () => {
    expect(buildShareHashtags('SOL', 'SOL')[1]).toBe('#SolanaGasFees')
    expect(buildShareHashtags('ETH', 'ETH')[1]).toBe('#ETHGasFees')
    expect(buildShareHashtags('NEWCHAIN', 'NC!')[1]).toBe('#NCGasFees')
  })
})
