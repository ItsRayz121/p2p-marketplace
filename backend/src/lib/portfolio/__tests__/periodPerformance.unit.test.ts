import { describe, it, expect } from 'vitest'
import type { EventRow } from '../summaryBuilder'
import { computePeriodPerformance, sameDayInZone, thin, MAX_CHART_POINTS, type StoredPoint } from '../periodPerformance'
import { openingRows } from '../period'

const START = new Date('2026-10-18T07:00:00Z')
const NOW = new Date('2026-10-18T09:00:00Z')

const lot = (qty: string, basisPkr: string | null, basisUsdt: string | null = null) => ({ eventId: 'old', acquiredAt: '2026-09-01T00:00:00Z', qty, basisPkr, basisUsdt })
const baselineRows = (currency: 'PKR' | 'USDT' = 'PKR') => openingRows([{ id: 'h1', assetId: 'A', lots: [lot('10', '1000', '3.5')] }], currency, START)
const buyRow = (id: string, at: string, qty: string, pkr: string): EventRow => ({
  id, assetId: 'A', type: 'BUY', occurredAt: new Date(at), quantity: qty, consideration: pkr, fee: '0', basis: null, zeroCost: false, quote: 'PKR', fxRate: null,
})
const sellRow = (id: string, at: string, qty: string, pkr: string): EventRow => ({ ...buyRow(id, at, qty, pkr), type: 'SELL' })
const snap = (iso: string, valuePkr: string | null, fx: string | null = '280', held = 1, priced = 1): StoredPoint => ({ takenAt: new Date(iso), valuePkr, fxUsdtPkr: fx, heldCount: held, pricedCount: priced })

const base = {
  currency: 'PKR' as const, version: 1, startedAt: START, timezone: 'Asia/Karachi', startedToday: true, now: NOW,
  live: { value: '1500', priced: 1, held: 1 }, openingMarketValue: '1400',
}

describe('the series starts at the tracking baseline', () => {
  it('a single observation is one point (the live value), never a trend', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [] })
    expect(r.points).toHaveLength(1)
    expect(r.points[0]).toMatchObject({ t: NOW.toISOString(), value: '1500', held: 1, priced: 1 })
    expect(r.tracking).toMatchObject({ startedToday: true, observations: 1, openingMarketValue: '1400' })
    expect(r.from).toBe(START.toISOString())
  })
  it('never draws anything before the cutover, even when asked for an earlier range', () => {
    const r = computePeriodPerformance({
      ...base, rows: baselineRows(), from: new Date('2026-06-22T00:00:00Z'),
      snapshots: [snap('2026-07-01T00:00:00Z', '999'), snap(START.toISOString(), '1400'), snap('2026-10-18T08:00:00Z', '1450')],
    })
    expect(r.from).toBe(START.toISOString())
    expect(r.points.map((p) => p.t)).toEqual([START.toISOString(), '2026-10-18T08:00:00.000Z', NOW.toISOString()])
    expect(r.points.map((p) => p.value)).toEqual(['1400', '1450', '1500'])
  })
  it('points are ordered and deduplicated; a stored point at "now" yields to the live one', () => {
    const r = computePeriodPerformance({
      ...base, rows: baselineRows(),
      snapshots: [snap('2026-10-18T08:00:00Z', '1450'), snap('2026-10-18T08:00:00Z', '1450'), snap(START.toISOString(), '1400'), snap(NOW.toISOString(), '1')],
    })
    expect(r.points.map((p) => p.t)).toEqual([START.toISOString(), '2026-10-18T08:00:00.000Z', NOW.toISOString()])
    expect(r.points[2]!.value).toBe('1500')
  })
})

describe('gaps are real gaps', () => {
  it('a point whose value could not be determined stays null (not zero, not interpolated)', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [snap(START.toISOString(), '1400'), snap('2026-10-18T08:00:00Z', null, '280', 1, 0)] })
    expect(r.points.map((p) => p.value)).toEqual(['1400', null, '1500'])
    expect(r.points[1]).toMatchObject({ priced: 0, held: 1 })
    expect(r.tracking.observations).toBe(2)
  })
  it('an unknown live value is a gap at the end, and the period gain is then unavailable', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [], live: { value: null, priced: 0, held: 1 } })
    expect(r.points[0]!.value).toBeNull()
    expect(r.period.gain).toBeNull()
    expect(r.period.gainUnavailableReason).toMatch(/missing/i)
  })
})

describe('currency switch changes presentation only', () => {
  it('USDT shows each stored point at the rate of its own moment; PKR is untouched', () => {
    const snaps = [snap(START.toISOString(), '1400', '280'), snap('2026-10-18T08:00:00Z', '1450', '290')]
    const pkr = computePeriodPerformance({ ...base, rows: baselineRows('PKR'), snapshots: snaps })
    const usdt = computePeriodPerformance({ ...base, currency: 'USDT', rows: baselineRows('USDT'), snapshots: snaps, live: { value: '5', priced: 1, held: 1 }, openingMarketValue: '5' })
    expect(pkr.points.map((p) => p.value)).toEqual(['1400', '1450', '1500'])
    expect(usdt.points.map((p) => p.value)).toEqual(['5', '5', '5'])
    expect(usdt.points.map((p) => p.held)).toEqual(pkr.points.map((p) => p.held))
  })
  it('a point with no rate cannot be shown in USDT, so it is a gap there', () => {
    const r = computePeriodPerformance({ ...base, currency: 'USDT', rows: baselineRows('USDT'), snapshots: [snap(START.toISOString(), '1400', null)], live: { value: '5', priced: 1, held: 1 }, openingMarketValue: null })
    expect(r.points.map((p) => p.value)).toEqual([null, '5'])
  })
})

describe('performance since tracking began (adjusted for money in and out)', () => {
  it('uses the opening MARKET value as the start, not the actual cost', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [] })
    expect(r.period).toMatchObject({ valueStart: '1400', valueEnd: '1500', gain: '100', moneyIn: '0', moneyOut: '0' })
  })
  it('a purchase in the period is money in: it is not counted as performance', () => {
    const rows = [...baselineRows(), buyRow('b1', '2026-10-18T08:00:00Z', '1', '150')]
    const r = computePeriodPerformance({ ...base, rows, snapshots: [], live: { value: '1650', priced: 1, held: 1 } })
    expect(r.period).toMatchObject({ moneyIn: '150', gain: '100' }) // 1650 - 1400 - 150
  })
  it('a sale is money out; its profit is measured against the ACTUAL cost of the baseline lot', () => {
    const rows = [...baselineRows(), sellRow('s1', '2026-10-18T08:00:00Z', '5', '700')]
    const r = computePeriodPerformance({ ...base, rows, snapshots: [], live: { value: '750', priced: 1, held: 1 } })
    expect(r.period.realized).toBe('200') // 700 - 5 * 100
    expect(r.period).toMatchObject({ moneyOut: '700', gain: '50' }) // 750 - 1400 + 700
    expect(r.points.at(-1)).toMatchObject({ realized: '200', costBasis: '500' })
  })
  it('an entry recorded late but dated before the cutover counts from the cutover (clamped) as money in', () => {
    const late = { ...buyRow('late', '2026-10-17T00:00:00Z', '1', '100'), occurredAt: START } // the service clamps it to the cutover
    const r = computePeriodPerformance({ ...base, rows: [...baselineRows(), late], snapshots: [], live: { value: '1600', priced: 1, held: 1 } })
    expect(r.period.moneyIn).toBe('100')
    expect(r.period.gain).toBe('100')
  })
  it('holdings added by hand in the period make the gain unavailable rather than guessed', () => {
    const opening: EventRow = { ...buyRow('o2', '2026-10-18T08:00:00Z', '3', '0'), type: 'OPENING', consideration: null, fee: null, basis: null }
    const r = computePeriodPerformance({ ...base, rows: [...baselineRows(), opening], snapshots: [] })
    expect(r.period.gain).toBeNull()
    expect(r.period.openingsAdded).toBe(1)
  })
  it('an unknown opening market value (a token had no valid quote that day) leaves the gain unavailable', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [], openingMarketValue: null })
    expect(r.period.gain).toBeNull()
    expect(r.period.gainUnavailableReason).toMatch(/day tracking started/)
  })
  it('a later range start uses a stored point taken close to it, or says it is unavailable', () => {
    const from = new Date('2026-10-18T08:00:00Z')
    const near = computePeriodPerformance({ ...base, rows: baselineRows(), from, snapshots: [snap('2026-10-18T08:05:00Z', '1450')] })
    expect(near.period.valueStart).toBe('1450')
    const far = computePeriodPerformance({ ...base, rows: baselineRows(), from: new Date('2026-10-19T12:00:00Z'), snapshots: [snap(START.toISOString(), '1400')], now: new Date('2026-10-20T00:00:00Z') })
    expect(far.period.valueStart).toBeNull()
  })
})

describe('long histories', () => {
  it('thins evenly, keeping the first and the last, and never more than the cap', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i)
    const t = thin(items, 120)
    expect(t).toHaveLength(120)
    expect(t[0]).toBe(0)
    expect(t.at(-1)).toBe(999)
    expect(thin([1, 2, 3], 120)).toEqual([1, 2, 3])
  })
  it('a year of stored points stays within the cap and stays ordered', () => {
    const snaps = Array.from({ length: 1500 }, (_, i) => snap(new Date(START.getTime() + i * 60_000).toISOString(), String(1400 + i)))
    const r = computePeriodPerformance({ ...base, now: new Date(START.getTime() + 2000 * 60_000), rows: baselineRows(), snapshots: snaps })
    expect(r.points.length).toBeLessThanOrEqual(MAX_CHART_POINTS)
    const ts = r.points.map((p) => Date.parse(p.t))
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })
})

describe('ranges and days', () => {
  it('an end a few seconds before the server clock (the browser clock) still includes the live point', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [snap(START.toISOString(), '1400')], to: new Date(NOW.getTime() - 3000) })
    expect(r.points.map((p) => p.t)).toEqual([START.toISOString(), NOW.toISOString()])
    expect(r.to).toBe(NOW.toISOString())
  })
  it('a range with no observations is empty, not an error', () => {
    const r = computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [snap(START.toISOString(), '1400')], from: new Date('2026-10-18T07:30:00Z'), to: new Date('2026-10-18T08:00:00Z') })
    expect(r.points).toEqual([])
    expect(r.tracking.observations).toBe(0)
  })
  it('rejects an inverted range', () => {
    expect(() => computePeriodPerformance({ ...base, rows: baselineRows(), snapshots: [], from: new Date('2026-10-18T09:00:00Z'), to: new Date('2026-10-18T08:00:00Z') })).toThrow()
  })
  it('"today" is decided in the business timezone', () => {
    // 20:00 UTC on the 17th is already the 18th in Karachi (UTC+5).
    expect(sameDayInZone(new Date('2026-10-17T20:00:00Z'), new Date('2026-10-18T03:00:00Z'), 'Asia/Karachi')).toBe(true)
    expect(sameDayInZone(new Date('2026-10-17T20:00:00Z'), new Date('2026-10-18T03:00:00Z'), 'UTC')).toBe(false)
    expect(sameDayInZone(new Date('2026-10-17T20:00:00Z'), new Date('2026-10-17T21:00:00Z'), 'Not/AZone')).toBe(true)
  })
})
