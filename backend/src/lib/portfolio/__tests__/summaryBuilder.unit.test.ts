import { describe, it, expect } from 'vitest'
import { buildSummary, type EventRow, type PriceRow } from '../summaryBuilder'
import type { Quote } from '../currency'

let n = 0
const row = (o: Partial<EventRow> & Pick<EventRow, 'assetId' | 'type' | 'quantity'>): EventRow => ({
  id: `e${++n}`, occurredAt: new Date('2026-01-01T00:00:00Z'), consideration: null, fee: null, basis: null,
  zeroCost: false, quote: 'PKR', fxRate: null, ...o,
})
const price = (assetId: string, p: string, quote: Quote = 'PKR'): PriceRow => ({ assetId, price: p, quote, observedAt: new Date('2026-10-16T09:00:00Z') })

// Spec fixture, all in PKR with no rates stored.
const pkrFixture = () => [
  row({ assetId: 'MEC', type: 'BUY', quantity: '100', consideration: '100000', fee: '1000', occurredAt: new Date('2026-01-01T00:00:00Z') }),
  row({ assetId: 'MEC', type: 'SELL', quantity: '40', consideration: '52000', fee: '400', occurredAt: new Date('2026-01-02T00:00:00Z') }),
  row({ assetId: 'SDA', type: 'BUY', quantity: '1000', consideration: '10000' }),
  row({ assetId: 'RUBI', type: 'BUY', quantity: '1000', consideration: '12000' }),
]
const pkrPrices = () => [price('MEC', '1200'), price('SDA', '8'), price('RUBI', '15')]

describe('PKR reporting', () => {
  it('matches the spec numbers and needs no rate at all when everything is PKR', () => {
    const r = buildSummary({ events: pkrFixture(), prices: pkrPrices(), currency: 'PKR', platformRate: null })
    expect(r.summary.knownRealized).toBe('11200')
    expect(r.summary.pricedValue).toBe('95000') // 72,000 + 8,000 + 15,000
    expect(r.summary.partial).toBe(false)
    expect(r.fxUnavailableAssets).toEqual([])
  })
  it('does not leak the per-sale detail into the response', () => {
    const r = buildSummary({ events: pkrFixture(), prices: pkrPrices(), currency: 'PKR', platformRate: null })
    expect(r.summary.positions[0]).not.toHaveProperty('realizedByEvent')
  })
})

describe('USDT reporting (each record at its own rate)', () => {
  it('PKR records with stored rates convert at those rates, not today\'s', () => {
    const events = [
      row({ assetId: 'A', type: 'BUY', quantity: '10', consideration: '2800', fxRate: '280', occurredAt: new Date('2026-01-01T00:00:00Z') }),
      row({ assetId: 'A', type: 'BUY', quantity: '10', consideration: '3000', fxRate: '300', occurredAt: new Date('2026-01-02T00:00:00Z') }),
    ]
    // basis: 2800/280 = 10 USDT, 3000/300 = 10 USDT -> 20 USDT in total, whatever today's rate is
    const r = buildSummary({ events, prices: [price('A', '1.5', 'USDT')], currency: 'USDT', platformRate: '999' })
    const p = r.summary.positions[0]!
    expect(p.knownRemainingBasis).toBe('20')
    expect(p.value).toBe('30') // 20 units x 1.5 USDT
    expect(p.unrealized).toBe('10')
  })
  it('a record with no rate leaves its token out and flags it; it is never zero or converted at today\'s rate', () => {
    const events = [
      row({ assetId: 'OLD', type: 'BUY', quantity: '5', consideration: '1400', fxRate: null }),
      row({ assetId: 'OK', type: 'BUY', quantity: '5', consideration: '1400', fxRate: '280' }),
    ]
    const r = buildSummary({ events, prices: [price('OLD', '1', 'USDT'), price('OK', '1', 'USDT')], currency: 'USDT', platformRate: '280' })
    expect(r.fxUnavailableAssets).toEqual(['OLD'])
    expect(r.summary.positions.map((p) => p.assetId)).toEqual(['OK'])
    expect(r.summary.partial).toBe(true)
    expect(r.summary.pricedValue).toBe('5')
  })
  it('one unconvertible record excludes the whole token, not just that record', () => {
    const events = [
      row({ assetId: 'A', type: 'BUY', quantity: '5', consideration: '1400', fxRate: '280' }),
      row({ assetId: 'A', type: 'SELL', quantity: '1', consideration: '300', fxRate: null }),
    ]
    const r = buildSummary({ events, prices: [], currency: 'USDT', platformRate: '280' })
    expect(r.fxUnavailableAssets).toEqual(['A'])
    expect(r.summary.positions).toEqual([])
  })
  it('USDT records shown in PKR use their own rate; USDT records shown in USDT need none', () => {
    const events = [row({ assetId: 'U', type: 'BUY', quantity: '400', consideration: '400', quote: 'USDT', fxRate: '278' })]
    const inPkr = buildSummary({ events, prices: [], currency: 'PKR', platformRate: null })
    expect(inPkr.summary.positions[0]!.knownRemainingBasis).toBe('111200')
    const inUsdt = buildSummary({ events: [{ ...events[0]!, fxRate: null }], prices: [], currency: 'USDT', platformRate: null })
    expect(inUsdt.summary.positions[0]!.knownRemainingBasis).toBe('400')
    expect(inUsdt.fxUnavailableAssets).toEqual([])
  })
  it('marks are valued at the CURRENT platform rate; with no rate they are unpriced, not zero', () => {
    const events = [row({ assetId: 'A', type: 'BUY', quantity: '10', consideration: '2800', fxRate: '280' })]
    const withRate = buildSummary({ events, prices: [price('A', '300')], currency: 'USDT', platformRate: '300' })
    expect(withRate.summary.positions[0]!.value).toBe('10') // 10 units x (300 PKR / 300)
    const noRate = buildSummary({ events, prices: [price('A', '300')], currency: 'USDT', platformRate: null })
    expect(noRate.summary.positions[0]!.value).toBeNull()
    expect(noRate.summary.unpricedAssets).toEqual(['A'])
    expect(noRate.fx.usdtPkr).toBeNull()
    expect(noRate.prices['A']!.price).toBeNull()
    expect(noRate.prices['A']!.original).toBe('300')
  })
  it('reports the original price and currency alongside the converted one', () => {
    const r = buildSummary({ events: [row({ assetId: 'A', type: 'BUY', quantity: '1', consideration: '280', fxRate: '280' })], prices: [price('A', '2', 'USDT')], currency: 'PKR', platformRate: '280' })
    expect(r.prices['A']).toMatchObject({ price: '560', original: '2', quote: 'USDT' })
  })
})
