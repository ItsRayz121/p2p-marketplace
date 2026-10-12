import { describe, it, expect, vi } from 'vitest'

vi.mock('../env', () => ({ env: { CSRF_SECRET: 'x'.repeat(32), FRONTEND_URL: 'https://rupchain.com' } }))

const { isForeignOrigin } = await import('../csrf')

describe('isForeignOrigin', () => {
  it('accepts our own frontend, ignoring case and a trailing slash', () => {
    expect(isForeignOrigin('https://rupchain.com', 'https://rupchain.com')).toBe(false)
    expect(isForeignOrigin('https://RupChain.com/', 'https://rupchain.com')).toBe(false)
  })
  it('refuses any other origin', () => {
    expect(isForeignOrigin('https://evil.example', 'https://rupchain.com')).toBe(true)
    expect(isForeignOrigin('https://rupchain.com.evil.example', 'https://rupchain.com')).toBe(true)
    expect(isForeignOrigin('http://rupchain.com', 'https://rupchain.com')).toBe(true)
    expect(isForeignOrigin('null', 'https://rupchain.com')).toBe(true)
  })
  it('does not block requests that send no Origin (non-browser clients)', () => {
    expect(isForeignOrigin(undefined, 'https://rupchain.com')).toBe(false)
    expect(isForeignOrigin('', 'https://rupchain.com')).toBe(false)
  })
})
