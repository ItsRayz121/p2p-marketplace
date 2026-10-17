import { describe, it, expect, vi } from 'vitest'

const secret = vi.hoisted(() => ({ value: 'first-secret-0123456789abcdef012345' }))
vi.mock('../env', () => ({ env: { get CNIC_HASH_SECRET() { return secret.value } } }))

import { linkedTokenRef } from '../portfolio/linkedTokenRef'

describe('linkedTokenRef', () => {
  it('is 32 hex characters and always the same for the same token', () => {
    expect(linkedTokenRef('tok1')).toMatch(/^[0-9a-f]{32}$/)
    expect(linkedTokenRef('tok1')).toBe(linkedTokenRef('tok1'))
  })
  it('differs between tokens and never contains the platform id', () => {
    expect(linkedTokenRef('tok1')).not.toBe(linkedTokenRef('tok2'))
    expect(linkedTokenRef('cmabc123def')).not.toContain('cmabc123def')
  })
  it('is keyed: without the server secret the reference cannot be computed or reversed', () => {
    const before = linkedTokenRef('tok1')
    secret.value = 'a-different-secret-0123456789abcdef'
    expect(linkedTokenRef('tok1')).not.toBe(before)
    secret.value = 'first-secret-0123456789abcdef012345'
  })
})
