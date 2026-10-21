import { describe, it, expect, vi } from 'vitest'

vi.mock('../../prisma', () => ({ db: {} }))
vi.mock('../../redis', () => ({ redis: {} }))
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../../services/adminNotification.service', () => ({ createAdminNotif: vi.fn() }))
vi.mock('../../env', () => ({ env: { JWT_SECRET: 'x'.repeat(40), WALLET_MASTER_KEY: undefined } }))

import { parseXProfileHandle, normaliseXHandle, xOwnershipCode } from '../xVerification'

describe('parseXProfileHandle', () => {
  it('reads a bare profile link', () => {
    expect(parseXProfileHandle('https://x.com/RupChain')).toBe('RupChain')
    expect(parseXProfileHandle('https://twitter.com/RupChain/')).toBe('RupChain')
    expect(parseXProfileHandle('https://www.x.com/rup_chain?s=20')).toBe('rup_chain')
  })
  it('rejects posts, reserved paths and other hosts', () => {
    expect(parseXProfileHandle('https://x.com/RupChain/status/123')).toBeNull()
    expect(parseXProfileHandle('https://x.com/intent/follow')).toBeNull()
    expect(parseXProfileHandle('https://evil.com/RupChain')).toBeNull()
    expect(parseXProfileHandle('http://x.com/RupChain')).toBeNull()
    expect(parseXProfileHandle(null)).toBeNull()
  })
})

describe('normaliseXHandle', () => {
  it('accepts @name, name and profile links', () => {
    expect(normaliseXHandle('@alice')).toBe('alice')
    expect(normaliseXHandle(' alice_1 ')).toBe('alice_1')
    expect(normaliseXHandle('https://x.com/alice')).toBe('alice')
  })
  it('rejects invalid handles', () => {
    expect(normaliseXHandle('')).toBeNull()
    expect(normaliseXHandle('a b')).toBeNull()
    expect(normaliseXHandle('averyveryverylonghandle')).toBeNull()
    expect(normaliseXHandle('alice?x=1')).toBeNull()
  })
})

describe('xOwnershipCode', () => {
  it('is stable per user and differs between users', () => {
    expect(xOwnershipCode('u1')).toBe(xOwnershipCode('u1'))
    expect(xOwnershipCode('u1')).not.toBe(xOwnershipCode('u2'))
    expect(xOwnershipCode('u1')).toMatch(/^RC-[0-9A-F]{8}$/)
  })
})
