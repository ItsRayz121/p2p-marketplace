import { describe, it, expect } from 'vitest'
import {
  CHANGE_MAX_AGE_MS, changeIfFresh, pick24h, pickGasProviderId, symbolMatches, toReferenceData, applySuperseded, type CgMarketRow,
} from '../referencePrices.rules'

const NOW = Date.parse('2026-10-10T06:10:00Z')
const spark = Array.from({ length: 168 }, (_, i) => 100 + Math.sin(i / 10) * 5)
const row = (o: Partial<CgMarketRow> = {}): CgMarketRow => ({
  id: 'ethereum', symbol: 'eth', current_price: 2494.84, last_updated: '2026-10-10T06:04:45.000Z',
  price_change_percentage_24h_in_currency: 0.11348, price_change_percentage_7d_in_currency: -6.749, sparkline_in_7d: { price: spark }, ...o,
})
const make = (o: Partial<CgMarketRow> = {}) => toReferenceData(row(o), '2026-10-10T06:09:00Z', NOW, 56)

describe('toReferenceData', () => {
  it('maps a live row: rounded 24h and 7d percentages, downsampled real series', () => {
    const d = make()!
    expect(d.change24hPct).toBe(0.11)
    expect(d.change7dPct).toBe(-6.75)
    expect(d.points).toHaveLength(56)
    expect(d.points[0]).toBe(spark[0])
    expect(d.points[55]).toBe(spark[167])
    expect(d.providerSymbol).toBe('eth')
  })
  it('a missing 24h change stays null (never 0), and a real zero stays 0', () => {
    expect(make({ price_change_percentage_24h_in_currency: null, price_change_percentage_24h: null })!.change24hPct).toBeNull()
    expect(make({ price_change_percentage_24h_in_currency: undefined })!.change24hPct).toBeNull()
    expect(make({ price_change_percentage_24h_in_currency: 0 })!.change24hPct).toBe(0)
  })
  it('falls back to the plain 24h field when the _in_currency one is absent', () => {
    expect(pick24h(row({ price_change_percentage_24h_in_currency: undefined, price_change_percentage_24h: -3.456 }))).toBe(-3.46)
  })
  it('rejects rows with no price, no real series, or NaN data instead of drawing a fake chart', () => {
    expect(make({ current_price: null })).toBeNull()
    expect(make({ sparkline_in_7d: { price: [] } })).toBeNull()
    expect(make({ sparkline_in_7d: { price: [5] } })).toBeNull()
    expect(make({ sparkline_in_7d: undefined })).toBeNull()
    expect(make({ sparkline_in_7d: { price: [1, Number.NaN, Number.POSITIVE_INFINITY] } })).toBeNull()
  })
  it('rejects a frozen/migrated listing (matic-network last updated Feb 2026)', () => {
    expect(make({ id: 'matic-network', symbol: 'matic', last_updated: '2026-02-03T01:57:00.000Z' })).toBeNull()
  })
  it('keeps a flat but real series (rendering handles flatness)', () => {
    expect(make({ sparkline_in_7d: { price: [1, 1, 1, 1] } })!.points).toEqual([1, 1, 1, 1])
  })
})

describe('changeIfFresh', () => {
  const d = { change24hPct: 1.5, fetchedAt: new Date(NOW - 60_000).toISOString() }
  it('shows the 24h change only while its fetch is recent', () => {
    expect(changeIfFresh(d, NOW)).toBe(1.5)
    expect(changeIfFresh({ ...d, fetchedAt: new Date(NOW - CHANGE_MAX_AGE_MS - 1000).toISOString() }, NOW)).toBeNull()
  })
  it('never turns missing into zero', () => {
    expect(changeIfFresh({ change24hPct: null, fetchedAt: d.fetchedAt }, NOW)).toBeNull()
    expect(changeIfFresh({ change24hPct: 0, fetchedAt: d.fetchedAt }, NOW)).toBe(0)
  })
  it('treats an unparsable timestamp as not fresh', () => {
    expect(changeIfFresh({ change24hPct: 2, fetchedAt: 'garbage' }, NOW)).toBeNull()
  })
})

describe('mapping safety', () => {
  const tok = (coingeckoId: string | null, tokenType = 'native', chainCoingeckoId: string | null = null) => ({ coingeckoId, tokenType, chainCoingeckoId })

  it('replaces the frozen MATIC id with the live POL id', () => {
    expect(applySuperseded('matic-network')).toBe('polygon-ecosystem-token')
    expect(pickGasProviderId([tok(null, 'native', 'matic-network')], 'matic-network')).toEqual({ id: 'polygon-ecosystem-token' })
    expect(pickGasProviderId([tok(null, 'native', null)], 'matic-network')).toEqual({ id: 'polygon-ecosystem-token' })
  })
  it('an ETH asset configured on several chains maps once when ids agree', () => {
    expect(pickGasProviderId([tok(null, 'native', 'ethereum'), tok(null, 'native', 'ethereum')], 'ethereum')).toEqual({ id: 'ethereum' })
  })
  it('conflicting ids resolve only to the known native id; otherwise stay unmapped', () => {
    expect(pickGasProviderId([tok(null, 'native', 'ethereum'), tok(null, 'native', 'base-protocol')], 'ethereum')).toEqual({ id: 'ethereum' })
    expect(pickGasProviderId([tok('foo', 'native'), tok('bar', 'native')], undefined)).toEqual({ reason: 'ambiguous' })
  })
  it('a non-native token with no explicit id is never mapped by ticker', () => {
    expect(pickGasProviderId([tok(null, 'erc20', 'ethereum')], 'ethereum')).toEqual({ reason: 'no_provider_id' })
  })
  it('an explicit token id wins and a native with nothing configured uses the static id', () => {
    expect(pickGasProviderId([tok('wrapped-thing', 'erc20')], undefined)).toEqual({ id: 'wrapped-thing' })
    expect(pickGasProviderId([tok(null, 'native')], 'sui')).toEqual({ id: 'sui' })
    expect(pickGasProviderId([tok(null, 'native')], undefined)).toEqual({ reason: 'no_provider_id' })
  })
  it('the provider ticker must agree, so a ticker collision never shows another token', () => {
    expect(symbolMatches('ETH', 'eth')).toBe(true)
    expect(symbolMatches('ETH', 'base')).toBe(false)
    expect(symbolMatches('ETH', null)).toBe(false)
    expect(symbolMatches('POL', 'pol')).toBe(true)
    expect(symbolMatches('MATIC', 'pol')).toBe(true)
    expect(symbolMatches('TON', 'gram')).toBe(true)
    expect(symbolMatches('BNB', 'pol')).toBe(false)
    expect(symbolMatches('SUI', 'gram')).toBe(false)
  })
})
