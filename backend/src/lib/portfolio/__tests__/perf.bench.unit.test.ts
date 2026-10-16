import { describe, it, expect } from 'vitest'
import { computePerformance, MAX_POINTS } from '../performance'
import { buildSummary, type EventRow, type PriceRow } from '../summaryBuilder'

/**
 * Worst-case sizing: the per-user caps are 5,000 entries and 200 tokens. A request must stay well
 * inside what a web server can do on a request thread.
 */
const T0 = Date.UTC(2024, 0, 1)
const DAY = 86_400_000

function worstCase(assets: number, events: number): { rows: EventRow[]; prices: PriceRow[] } {
  const rows: EventRow[] = []
  for (let i = 0; i < events; i++) {
    const asset = `a${i % assets}`
    const buy = i % 3 !== 2
    rows.push({
      id: `e${i}`, assetId: asset, type: buy ? 'BUY' : 'SELL', occurredAt: new Date(T0 + i * (DAY / 4)),
      quantity: buy ? '10.123456789' : '3.5', consideration: buy ? '1234.56' : '500.25', fee: '1.5', basis: null, zeroCost: false,
      quote: 'PKR', fxRate: null,
    })
  }
  const prices: PriceRow[] = []
  for (let a = 0; a < assets; a++) for (let d = 0; d < 20; d++) prices.push({ assetId: `a${a}`, price: String(100 + d), quote: 'PKR', observedAt: new Date(T0 + d * 30 * DAY) })
  return { rows, prices }
}

describe('worst-case timing (5,000 entries)', () => {
  it('the summary for 5,000 entries across 200 tokens finishes quickly', () => {
    const { rows, prices } = worstCase(200, 5000)
    const t = Date.now()
    buildSummary({ events: rows, prices: prices.slice(-200), currency: 'PKR', platformRate: null })
    const ms = Date.now() - t
    expect(ms).toBeLessThan(3000)
  })
  it.each([[5, 5000], [200, 5000], [1, 5000]])('the %i-token / %i-entry chart request finishes within a safe time', (assets, events) => {
    const { rows, prices } = worstCase(assets, events)
    const t = Date.now()
    computePerformance({
      events: rows, prices, currency: 'PKR', currentMarks: {}, from: new Date(T0), to: new Date(T0 + 1300 * DAY), now: new Date(T0 + 1400 * DAY), maxPoints: MAX_POINTS,
    })
    const ms = Date.now() - t
    expect(ms).toBeLessThan(10_000)
  })
})
