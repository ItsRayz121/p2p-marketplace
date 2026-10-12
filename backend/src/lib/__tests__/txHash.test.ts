import { describe, it, expect } from 'vitest'
import { isWellFormedEvmTxHash } from '../txHash'

describe('isWellFormedEvmTxHash', () => {
  it('accepts a 32-byte hash', () => {
    expect(isWellFormedEvmTxHash('0x' + 'ab'.repeat(32))).toBe(true)
  })
  it('rejects an address-length value (the case seen in production logs)', () => {
    expect(isWellFormedEvmTxHash('0x' + 'ab'.repeat(20))).toBe(false)
  })
  it.each([null, undefined, '', '0x', 'ab'.repeat(32), '0x' + 'zz'.repeat(32), ' 0x' + 'ab'.repeat(32)])('rejects %j', (v) => {
    expect(isWellFormedEvmTxHash(v as string | null | undefined)).toBe(false)
  })
})
