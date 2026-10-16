import { describe, it, expect } from 'vitest'
import { identityKey, splitIdentityKey, effectiveThreshold, bucketDown, buildInterestReport, type GroupCounts } from '../interest'

const g = (o: Partial<GroupCounts> & { identityKey: string }): GroupCounts => ({ total: 30, recent: 10, previous: 10, names: [], ...o })

describe('identityKey', () => {
  it('needs both a network and a contract', () => {
    expect(identityKey('BEP20', '0xAbC')).toBe('bep20:0xabc')
    expect(identityKey('', '0xabc')).toBeNull()
    expect(identityKey('BEP20', '')).toBeNull()
    expect(identityKey(null, null)).toBeNull()
  })
  it('the same token written differently is the same group (hex addresses are case-insensitive)', () => {
    expect(identityKey(' bep20 ', '0xABCDEF')).toBe(identityKey('BEP20', '0xabcdef'))
    expect(identityKey('Ethereum  Mainnet', '0x1')).toBe('ethereum mainnet:0x1')
  })
  it('non-hex addresses keep their case (Solana-style addresses are case-sensitive)', () => {
    expect(identityKey('Solana', 'So11111111111111111111111111111111111111112')).toBe('solana:So11111111111111111111111111111111111111112')
    expect(identityKey('Solana', 'AbC')).not.toBe(identityKey('Solana', 'abc'))
  })
  it('a name can never be an identity: the key contains no name', () => {
    expect(identityKey('BEP20', '0xabc')).not.toMatch(/meta|earth/i)
  })
  it('splits back into network and contract, even if the contract contains a colon', () => {
    expect(splitIdentityKey('sui:0x2::coin::COIN')).toEqual({ network: 'sui', contract: '0x2::coin::COIN' })
  })
})

describe('threshold and bucketing', () => {
  it('the configured threshold can never be set below the floor', () => {
    expect(effectiveThreshold(1)).toBe(10)
    expect(effectiveThreshold(0)).toBe(10)
    expect(effectiveThreshold(-5)).toBe(10)
    expect(effectiveThreshold(25.9)).toBe(25)
    expect(effectiveThreshold(Number.NaN)).toBe(20)
  })
  it('counts are rounded down to a multiple of 5', () => {
    expect([0, 4, 5, 9, 20, 24, 25, 99].map(bucketDown)).toEqual([0, 0, 5, 5, 20, 20, 25, 95])
  })
})

describe('buildInterestReport (what an admin may see)', () => {
  it('drops groups below the threshold entirely and only counts how many were dropped', () => {
    const r = buildInterestReport([g({ identityKey: 'bep20:0xa', total: 19 }), g({ identityKey: 'bep20:0xb', total: 20 }), g({ identityKey: 'bep20:0xc', total: 3 })], 20)
    expect(r.groups.map((x) => x.contract)).toEqual(['0xb'])
    expect(r.suppressedGroups).toBe(2)
    expect(JSON.stringify(r)).not.toContain('0xa')
    expect(JSON.stringify(r)).not.toContain('0xc')
  })
  it('shows only a rounded-down "at least" count', () => {
    const r = buildInterestReport([g({ identityKey: 'bep20:0xa', total: 27 })], 20)
    expect(r.groups[0]!.approxAccounts).toBe(25)
  })
  it('one more person joining a group cannot be detected from a rounded count most of the time', () => {
    const at = (total: number) => buildInterestReport([g({ identityKey: 'bep20:0xa', total })], 20).groups[0]!.approxAccounts
    expect(at(26)).toBe(at(27))
    expect(at(21)).toBe(at(22))
  })
  it('suggests a common name only when at least `threshold` accounts use it', () => {
    const names = [{ name: 'Meta Earth', count: 22 }, { name: 'MEC', count: 8 }]
    expect(buildInterestReport([g({ identityKey: 'bep20:0xa', total: 30, names })], 20).groups[0]!.commonName).toBe('Meta Earth')
    const scattered = [{ name: 'a', count: 10 }, { name: 'b', count: 10 }, { name: 'c', count: 10 }]
    expect(buildInterestReport([g({ identityKey: 'bep20:0xa', total: 30, names: scattered })], 20).groups[0]!.commonName).toBeNull()
  })
  it('never exposes any individual: no user ids, no names below the threshold, no raw counts', () => {
    const names = [{ name: 'Secret personal label', count: 3 }]
    const text = JSON.stringify(buildInterestReport([g({ identityKey: 'bep20:0xa', total: 33, recent: 7, previous: 2, names })], 20))
    expect(text).not.toContain('Secret personal label')
    expect(text).not.toMatch(/userId|"total"|"recent"|"previous"/)
    expect(text).not.toContain('33')
  })
  it('the trend compares bucketed values, so a single join cannot flip it', () => {
    const t = (recent: number, previous: number) => buildInterestReport([g({ identityKey: 'bep20:0xa', recent, previous })], 20).groups[0]!.trend
    expect(t(6, 5)).toBe('steady')
    expect(t(9, 5)).toBe('steady')
    expect(t(10, 5)).toBe('rising')
    expect(t(0, 8)).toBe('falling')
    expect(t(12, 14)).toBe('steady')
  })
  it('largest groups first, ties broken deterministically', () => {
    const r = buildInterestReport([g({ identityKey: 'bep20:0xb', total: 25 }), g({ identityKey: 'bep20:0xa', total: 25 }), g({ identityKey: 'bep20:0xc', total: 60 })], 20)
    expect(r.groups.map((x) => x.contract)).toEqual(['0xc', '0xa', '0xb'])
  })
  it('an empty input is an empty report', () => {
    expect(buildInterestReport([], 20)).toEqual({ threshold: 20, groups: [], suppressedGroups: 0 })
  })
})
