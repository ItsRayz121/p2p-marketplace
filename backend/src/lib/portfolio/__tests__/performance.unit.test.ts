import { describe, it, expect } from 'vitest'
import { computePerformance, currentMarksIn, MAX_POINTS } from '../performance'
import type { EventRow, PriceRow } from '../summaryBuilder'

let n = 0
const day = (d: number) => new Date(Date.UTC(2026, 0, d))
const ev = (o: Partial<EventRow> & Pick<EventRow, 'assetId' | 'type' | 'quantity' | 'occurredAt'>): EventRow => ({
  id: `e${++n}`, consideration: null, fee: null, basis: null, zeroCost: false, quote: 'PKR', fxRate: null, ...o,
})
const obs = (assetId: string, price: string, at: Date, quote: 'PKR' | 'USDT' = 'PKR'): PriceRow => ({ assetId, price, quote, observedAt: at })

// Spec fixture: buy 100 @1,000 + fee 1,000 on day 1; sell 40 @1,300 - fee 400 on day 10.
const mec = () => [
  ev({ assetId: 'MEC', type: 'BUY', quantity: '100', consideration: '100000', fee: '1000', occurredAt: day(1) }),
  ev({ assetId: 'MEC', type: 'SELL', quantity: '40', consideration: '52000', fee: '400', occurredAt: day(10) }),
]
const run = (o: Partial<Parameters<typeof computePerformance>[0]> & { events: EventRow[] }) =>
  computePerformance({
    prices: [], currency: 'PKR', currentMarks: {}, from: day(1), to: day(20), now: day(30), ...o,
  })

describe('series', () => {
  it('has the requested shape and ends exactly at "to"', () => {
    const r = run({ events: mec(), maxPoints: 5 })
    expect(r.points).toHaveLength(5)
    expect(r.points[0]!.t).toBe(day(1).toISOString())
    expect(r.points[4]!.t).toBe(day(20).toISOString())
  })
  it('never exceeds the point cap', () => {
    expect(run({ events: mec(), maxPoints: 5000 }).points).toHaveLength(MAX_POINTS)
  })
  it('cost basis and realized profit follow the entries over time (spec fixture)', () => {
    const r = run({ events: mec(), maxPoints: 20 })
    const before = r.points[0]!         // day 1: bought, nothing sold yet
    expect(before.costBasis).toBe('101000')
    expect(before.realized).toBe('0')
    const after = r.points[r.points.length - 1]! // day 20: after the sale
    expect(after.costBasis).toBe('60600')
    expect(after.realized).toBe('11200')
    expect(after.complete).toBe(true)
  })
  it('before any entry nothing is held and nothing is invented', () => {
    const r = run({ events: mec(), from: new Date(Date.UTC(2025, 11, 1)), to: day(2), maxPoints: 3 })
    expect(r.points[0]).toMatchObject({ costBasis: '0', realized: '0', held: 0, value: '0' })
  })
})

describe('value is shown only where genuinely priced (gaps, no interpolation)', () => {
  it('no price entered -> value is null (a gap), not zero', () => {
    const r = run({ events: mec(), maxPoints: 3 })
    expect(r.points.every((p) => p.value === null)).toBe(true)
    expect(r.points[0]).toMatchObject({ priced: 0, held: 1 })
  })
  it('uses the latest price entered at or before each moment and does not look ahead', () => {
    const r = run({ events: mec(), prices: [obs('MEC', '1100', day(5)), obs('MEC', '1300', day(15))], maxPoints: 20 })
    const at = (d: number) => r.points.reduce((a, b) => Math.abs(Date.parse(b.t) - day(d).getTime()) < Math.abs(Date.parse(a.t) - day(d).getTime()) ? b : a)
    expect(at(3).value).toBeNull()                       // before the first price: gap
    expect(at(7).value).toBe(String(100 * 1100))         // 100 units x 1,100
    expect(at(18).value).toBe(String(60 * 1300))         // 60 units x 1,300 after the sale
  })
  it('a price entered in the other currency is NOT converted for history (it would need that day\'s rate)', () => {
    const r = run({ events: mec(), prices: [obs('MEC', '4', day(5), 'USDT')], maxPoints: 10 })
    expect(r.points.every((p) => p.value === null)).toBe(true)
  })
  it('the last point at "now" uses the current marks', () => {
    const r = run({ events: mec(), to: day(30), now: day(30), currentMarks: { MEC: '1200' }, maxPoints: 4 })
    expect(r.points[3]!.value).toBe('72000')
  })
  it('a portfolio with one unpriced token among priced ones has no value at that moment', () => {
    const events = [...mec(), ev({ assetId: 'B', type: 'BUY', quantity: '1', consideration: '10', occurredAt: day(1) })]
    const r = run({ events, prices: [obs('MEC', '1000', day(1))], maxPoints: 3 })
    expect(r.points[2]!.value).toBeNull()
    expect(r.points[2]).toMatchObject({ priced: 1, held: 2 })
  })
})

describe('period statistics (day 5 -> day 20)', () => {
  it('realized and money in/out count only entries inside the period', () => {
    const r = run({ events: mec(), from: day(5), to: day(20) })
    expect(r.period.realized).toBe('11200')
    expect(r.period.moneyIn).toBe('0')       // the buy was on day 1, before the period
    expect(r.period.moneyOut).toBe('51600')  // 52,000 - 400
    expect(r.period.realizedComplete).toBe(true)
  })
  it('a period before the sale has no realized result', () => {
    const r = run({ events: mec(), from: new Date(Date.UTC(2025, 11, 31)), to: day(9) })
    expect(r.period.realized).toBe('0')
    expect(r.period.moneyIn).toBe('101000')
  })
  it('the start of the period itself is excluded, the end included', () => {
    const r = run({ events: mec(), from: day(10), to: day(20) })
    expect(r.period.moneyOut).toBe('0') // sale is exactly at "from"
    const r2 = run({ events: mec(), from: day(1), to: day(10) })
    expect(r2.period.realized).toBe('11200') // sale is exactly at "to"
  })
  it('gain = end value - start value - money in + money out, when both ends are priced', () => {
    const prices = [obs('MEC', '1000', day(1)), obs('MEC', '1300', day(18))]
    const r = run({ events: mec(), prices, from: day(2), to: day(20) })
    // start: 100 x 1,000 = 100,000 ; end: 60 x 1,300 = 78,000 ; out 51,600 ; in 0
    expect(r.period.valueStart).toBe('100000')
    expect(r.period.valueEnd).toBe('78000')
    expect(r.period.gain).toBe(String(78000 - 100000 + 51600))
    expect(r.period.gainUnavailableReason).toBeNull()
  })
  it('gain is unavailable (with a reason) when a price is missing at either end', () => {
    const r = run({ events: mec(), prices: [obs('MEC', '1000', day(15))], from: day(2), to: day(20) })
    expect(r.period.gain).toBeNull()
    expect(r.period.gainUnavailableReason).toMatch(/price is missing/)
    expect(r.period.returnPct).toBeNull()
  })
  it('opening holdings added in the period make the gain unavailable (their value at that time is unknown)', () => {
    const events = [...mec(), ev({ assetId: 'MEC', type: 'OPENING', quantity: '5', occurredAt: day(12) })]
    const prices = [obs('MEC', '1000', day(1))]
    const r = run({ events, prices, from: day(2), to: day(20) })
    expect(r.period.openingsAdded).toBe(1)
    expect(r.period.gain).toBeNull()
    expect(r.period.gainUnavailableReason).toMatch(/Opening holdings/)
  })
  it('Modified Dietz: flows are weighted by the time they were in the portfolio', () => {
    // start value 1,000 (10 units x 100); buy 10 more for 1,000 exactly halfway; end value 2,400
    const events = [
      ev({ assetId: 'A', type: 'BUY', quantity: '10', consideration: '1000', occurredAt: day(1) }),
      ev({ assetId: 'A', type: 'BUY', quantity: '10', consideration: '1000', occurredAt: day(11) }),
    ]
    const r = computePerformance({
      events, prices: [obs('A', '100', day(1)), obs('A', '120', day(20))], currency: 'PKR', currentMarks: {},
      from: day(1), to: day(21), now: day(30),
    })
    // gain = 2,400 - 1,000 - 1,000 = 400 ; denominator = 1,000 + 1,000 x 0.5 = 1,500 ; 26.67 %
    expect(r.period.gain).toBe('400')
    expect(r.period.returnPct).toBe('26.67')
    expect(r.period.returnMethod).toBe('MODIFIED_DIETZ')
  })
  it('no percentage when the denominator is not positive', () => {
    const events = [ev({ assetId: 'A', type: 'BUY', quantity: '1', consideration: '100', occurredAt: day(1) })]
    const r = computePerformance({
      events, prices: [obs('A', '100', day(1)), obs('A', '150', day(20))], currency: 'PKR', currentMarks: {},
      from: day(1), to: day(20), now: day(30),
    })
    // buy happened exactly at "from" (outside (from,to]); start value 100 -> fine and positive, so use a zero start:
    expect(r.period.valueStart).toBe('100')
    const empty = computePerformance({ events: [], prices: [], currency: 'PKR', currentMarks: {}, from: day(1), to: day(20), now: day(30) })
    expect(empty.period.returnPct).toBeNull()
  })
  it('incomplete realized results are flagged', () => {
    const events = [
      ev({ assetId: 'A', type: 'OPENING', quantity: '10', occurredAt: day(1) }), // unknown cost
      ev({ assetId: 'A', type: 'SELL', quantity: '4', consideration: '100', occurredAt: day(5) }),
    ]
    const r = run({ events, from: day(2), to: day(20) })
    expect(r.period.realizedComplete).toBe(false)
    expect(r.points[r.points.length - 1]!.complete).toBe(false)
    expect(r.points[r.points.length - 1]!.costBasis).toBeNull()
  })
})

describe('currency', () => {
  it('USDT records are shown in PKR at their own rate; missing rates exclude the token and are listed', () => {
    const events = [
      ev({ assetId: 'U', type: 'BUY', quantity: '1', consideration: '10', quote: 'USDT', fxRate: '280', occurredAt: day(1) }),
      ev({ assetId: 'X', type: 'BUY', quantity: '1', consideration: '10', quote: 'USDT', fxRate: null, occurredAt: day(1) }),
    ]
    const r = run({ events, maxPoints: 2 })
    expect(r.points[1]!.costBasis).toBe('2800')
    expect(r.fxUnavailableAssets).toEqual(['X'])
  })
  it('currentMarksIn converts at the current rate and returns null when impossible', () => {
    const prices = [obs('A', '2', day(1), 'USDT'), obs('B', '280', day(1), 'PKR')]
    expect(currentMarksIn(prices, 'PKR', '300')).toEqual({ A: '600', B: '280' })
    expect(currentMarksIn(prices, 'USDT', null)).toEqual({ A: '2', B: null })
  })
})

describe('input checks', () => {
  it('rejects an inverted range', () => {
    expect(() => run({ events: [], from: day(5), to: day(1) })).toThrow(/invalid range/)
  })
  it('a zero-length range returns a single point', () => {
    expect(run({ events: mec(), from: day(5), to: day(5) }).points).toHaveLength(1)
  })
})
