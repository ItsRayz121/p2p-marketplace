import { describe, it, expect, vi } from 'vitest'

vi.mock('../../env', () => ({ env: { WALLET_MASTER_KEY: 'a'.repeat(64) } }))
vi.mock('../../prisma', () => ({ db: {} }))
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../../services/adminNotification.service', () => ({ createAdminNotif: vi.fn() }))

import { checkPost, parseTweet, encryptSecret, decryptSecret, type XPost } from '../xVerification'

const start = new Date('2026-10-17T03:00:00Z')
const end = new Date('2026-10-17T04:00:00Z')

const good: XPost = {
  id: '1', text: 'Topped up through @RupChain https://t.co/x #RupChain #BNBGasFees #ad',
  createdAt: new Date('2026-10-17T03:23:17Z'), authorHandle: 'someone',
  urls: ['https://rupchain.com/s/GF-1?v=0'], hasMedia: true, isReply: false, isRetweet: false,
}
const run = (p: Partial<XPost>, handle: string | null = 'RupChain') =>
  checkPost({ post: { ...good, ...p }, orderRef: 'GF-1', handle, windowStart: start, windowEnd: end })

describe('checkPost', () => {
  it('passes a complete post', () => {
    expect(run({})).toMatchObject({ outcome: 'passed', issues: [] })
  })
  it('asks for the missing mention, hashtag, disclosure and link in plain language', () => {
    const r = run({ text: 'hello', urls: ['https://example.com'] })
    expect(r.outcome).toBe('failed')
    expect(r.issues.join(' ')).toMatch(/Mention @RupChain/)
    expect(r.issues.join(' ')).toMatch(/#RupChain/)
    expect(r.issues.join(' ')).toMatch(/#ad/)
    expect(r.issues.join(' ')).toMatch(/link to your order/)
  })
  it('does not accept a handle that only starts with the official one', () => {
    expect(run({ text: '@RupChainFake #RupChain #ad' }).issues.join(' ')).toMatch(/Mention @RupChain/)
  })
  it('rejects posts outside the offer window', () => {
    expect(run({ createdAt: new Date('2026-10-17T02:00:00Z') }).outcome).toBe('failed')
    expect(run({ createdAt: new Date('2026-10-17T05:00:00Z') }).outcome).toBe('failed')
    expect(run({ createdAt: new Date('2026-10-17T04:05:00Z') }).outcome).toBe('passed') // inside the grace period
  })
  it('is inconclusive, never failed, when the provider lacks link or time data', () => {
    const r = run({ urls: null, createdAt: null })
    expect(r.outcome).toBe('inconclusive')
    expect(r.unknown.length).toBe(2)
  })
  it('skips the mention rule when no official handle is configured', () => {
    expect(run({ text: '#RupChain #ad' }, null).outcome).toBe('passed')
  })
  it('flags reposts and replies', () => {
    expect(run({ isRetweet: true }).outcome).toBe('failed')
    expect(run({ isReply: true }).outcome).toBe('failed')
  })
})

describe('parseTweet', () => {
  it('reads the flattened shape', () => {
    const p = parseTweet({ id: '9', text: 'hi', createdAt: 'Sat Oct 17 03:23:17 +0000 2026', authorUserName: 'Rayzhills', hasMedia: true, isReply: false })
    expect(p).toMatchObject({ id: '9', authorHandle: 'Rayzhills', hasMedia: true, urls: null })
    expect(p?.createdAt?.toISOString()).toBe('2026-10-17T03:23:17.000Z')
  })
  it('reads the nested shape with expanded urls', () => {
    const p = parseTweet({ id: '9', text: 'hi', author: { userName: 'a' }, entities: { urls: [{ expanded_url: 'https://rupchain.com/s/X' }] } })
    expect(p).toMatchObject({ authorHandle: 'a', urls: ['https://rupchain.com/s/X'] })
  })
  it('rejects garbage', () => {
    expect(parseTweet({})).toBeNull()
  })
})

describe('secret storage', () => {
  it('round-trips and never contains the plain text', () => {
    const blob = encryptSecret('super-secret-key')
    expect(blob).not.toContain('super-secret-key')
    expect(decryptSecret(blob)).toBe('super-secret-key')
    expect(decryptSecret('not-base64-garbage')).toBeNull()
  })
})
