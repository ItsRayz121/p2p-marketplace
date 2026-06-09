/**
 * Unit tests for describeDeliveryError — the delivery-failure classifier that
 * turns raw provider/RPC noise (e.g. "Request failed with status code 500")
 * into an actionable code + reason + recommended action.
 */
import { describe, it, expect } from 'vitest'
import { describeDeliveryError } from '../gas.deliveryError'

describe('describeDeliveryError', () => {
  it('maps a TON 500 to a provider error with an action (the screenshot bug)', () => {
    const r = describeDeliveryError('TON', new Error('Request failed with status code 500'))
    expect(r.code).toBe('PROVIDER_ERROR')
    expect(r.reason).toMatch(/TON.*server error/i)
    expect(r.action).toMatch(/retry/i)
    // Raw tail preserved for forensics.
    expect(r.message).toContain('status code 500')
  })

  it('classifies an insufficient-balance code regardless of message', () => {
    const err = Object.assign(new Error('whatever'), { code: 'INSUFFICIENT_HOT_WALLET_BALANCE' })
    const r = describeDeliveryError('BSC', err)
    expect(r.code).toBe('INSUFFICIENT_HOT_WALLET_BALANCE')
    expect(r.action).toMatch(/refill/i)
  })

  it('detects a missing mnemonic / signing key', () => {
    const r = describeDeliveryError('SOL', new Error('GAS_SEED_CIPHERTEXT not configured'))
    expect(r.code).toBe('WALLET_NOT_CONFIGURED')
  })

  it('detects an invalid recipient address', () => {
    const r = describeDeliveryError('TRON', new Error('invalid base58 address'))
    expect(r.code).toBe('INVALID_RECIPIENT')
  })

  it('detects a rate-limit (429) distinctly from a 5xx', () => {
    const r = describeDeliveryError('ETH', new Error('Request failed with status code 429'))
    expect(r.code).toBe('PROVIDER_RATE_LIMITED')
  })

  it('detects timeouts / unreachable RPC', () => {
    for (const msg of ['ETIMEDOUT', 'fetch failed', 'socket hang up', 'ECONNREFUSED']) {
      expect(describeDeliveryError('MATIC', new Error(msg)).code).toBe('PROVIDER_TIMEOUT')
    }
  })

  it('detects nonce / mempool broadcast conflicts', () => {
    const r = describeDeliveryError('BSC', new Error('replacement transaction underpriced'))
    expect(r.code).toBe('TX_BROADCAST_CONFLICT')
  })

  it('falls back to a generic actionable error for unknown failures', () => {
    const r = describeDeliveryError('SUI', new Error('totally novel failure mode'))
    expect(r.code).toBe('DELIVERY_ERROR')
    expect(r.message).toMatch(/^\[DELIVERY_ERROR\]/)
  })

  it('truncates very long raw errors in the message', () => {
    const r = describeDeliveryError('TON', new Error('x'.repeat(500)))
    expect(r.message.length).toBeLessThan(400)
    expect(r.message).toContain('…')
  })
})
