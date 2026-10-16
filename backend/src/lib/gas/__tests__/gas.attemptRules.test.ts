import { describe, expect, it } from 'vitest'
import { classifyPriorAttempt, supportsAttemptJournal, EXPIRY_PROOF_AFTER_MS } from '../gas.attemptRules'

const base = { hasAttempt: true, chain: 'ETH', evm: true, state: 'not_found' as const, nonce: 7, senderConfirmedCount: 7, attemptAgeMs: 60 * 60_000 }

describe('classifyPriorAttempt — never allow a resend unless provably dead', () => {
  it('no journaled attempt → none', () => {
    expect(classifyPriorAttempt({ ...base, hasAttempt: false })).toBe('none')
  })
  it('success → landed (adopt, never resend/refund)', () => {
    expect(classifyPriorAttempt({ ...base, state: 'success' })).toBe('landed')
  })
  it('mined revert → dead', () => {
    expect(classifyPriorAttempt({ ...base, state: 'reverted' })).toBe('dead')
  })
  it('RPC unreachable → unresolved', () => {
    expect(classifyPriorAttempt({ ...base, state: 'unreachable' })).toBe('unresolved')
  })
  it('EVM not found, nonce NOT consumed → unresolved however old', () => {
    expect(classifyPriorAttempt({ ...base, senderConfirmedCount: 7 })).toBe('unresolved')
    expect(classifyPriorAttempt({ ...base, senderConfirmedCount: 6 })).toBe('unresolved')
  })
  it('EVM not found, nonce consumed by another tx → dead', () => {
    expect(classifyPriorAttempt({ ...base, senderConfirmedCount: 8 })).toBe('dead')
  })
  it('EVM mempool + nonce consumed → dead (replaced)', () => {
    expect(classifyPriorAttempt({ ...base, state: 'mempool', senderConfirmedCount: 9 })).toBe('dead')
  })
  it('EVM with missing nonce or unreadable count → unresolved', () => {
    expect(classifyPriorAttempt({ ...base, nonce: null, senderConfirmedCount: 99 })).toBe('unresolved')
    expect(classifyPriorAttempt({ ...base, senderConfirmedCount: null })).toBe('unresolved')
  })
  it('non-EVM not found only dead after the expiry window', () => {
    const sol = { ...base, chain: 'SOL', evm: false, nonce: null, senderConfirmedCount: null }
    expect(classifyPriorAttempt({ ...sol, attemptAgeMs: EXPIRY_PROOF_AFTER_MS - 1 })).toBe('unresolved')
    expect(classifyPriorAttempt({ ...sol, attemptAgeMs: EXPIRY_PROOF_AFTER_MS })).toBe('dead')
    expect(classifyPriorAttempt({ ...sol, attemptAgeMs: null })).toBe('unresolved')
  })
  it('non-EVM still in mempool is never dead by age alone', () => {
    expect(classifyPriorAttempt({ ...base, chain: 'TRON', evm: false, state: 'mempool', attemptAgeMs: 99 * 60_000 })).toBe('unresolved')
  })
  it('TON (no lookup, no expiry proof) is never provably dead', () => {
    expect(classifyPriorAttempt({ ...base, chain: 'TON', evm: false, attemptAgeMs: 99 * 60_000 })).toBe('unresolved')
  })
})

describe('supportsAttemptJournal', () => {
  it('journals EVM + Solana only', () => {
    for (const c of ['ETH', 'BSC', 'OPBNB', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX', 'SOL']) expect(supportsAttemptJournal(c)).toBe(true)
    for (const c of ['TRON', 'TON', 'SUI', 'APT']) expect(supportsAttemptJournal(c)).toBe(false)
  })
})
