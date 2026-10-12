import { describe, it, expect } from 'vitest'
import { csvCell } from '../csv'

describe('csvCell', () => {
  it.each(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
    'neutralises the formula trigger in %j',
    (v) => {
      const out = csvCell(v)
      expect(out.replace(/^"/, '').startsWith("'")).toBe(true)
    },
  )
  it('leaves ordinary text and numbers untouched', () => {
    expect(csvCell('alice')).toBe('alice')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
  })
  it('a formula that also needs quoting stays neutralised', () => {
    expect(csvCell('=1,2')).toBe(`"'=1,2"`)
  })
})
