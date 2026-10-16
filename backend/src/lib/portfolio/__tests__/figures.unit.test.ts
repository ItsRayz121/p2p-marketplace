import { describe, it, expect } from 'vitest'
import { computeFigures, type FigurePosition } from '../figures'
import { summarizePortfolio, type TradeEvent } from '../fifo'

const pos = (o: Partial<FigurePosition> = {}): FigurePosition => ({
  quantity: '10', value: '100', unrealized: '20', realizedKnown: '0', realizedComplete: true, soldCount: 0, soldIncompleteCount: 0, ...o,
})

describe('computeFigures: unknown is never shown as zero', () => {
  it('nothing tracked is a genuine zero', () => {
    const f = computeFigures([])
    expect(f.value).toEqual({ state: 'known', amount: '0', covered: 0, total: 0 })
    expect(f.realized.state).toBe('known')
    expect(f.heldCount).toBe(0)
  })

  it('held but no price: value and unrealized are unavailable (amount null), not 0', () => {
    const f = computeFigures([pos({ value: null, unrealized: null })])
    expect(f.value.state).toBe('unavailable')
    expect(f.value.amount).toBeNull()
    expect(f.unrealized.state).toBe('unavailable')
    expect(f.total.state).toBe('unavailable')
  })

  it('some priced: partial with the covered sum', () => {
    const f = computeFigures([pos(), pos({ value: null, unrealized: null })])
    expect(f.value).toMatchObject({ state: 'partial', amount: '100', covered: 1, total: 2 })
    expect(f.unrealized).toMatchObject({ state: 'partial', amount: '20' })
  })

  it('everything known is "known"', () => {
    const f = computeFigures([pos(), pos({ value: '50', unrealized: '-5' })])
    expect(f.value).toMatchObject({ state: 'known', amount: '150' })
    expect(f.unrealized).toMatchObject({ state: 'known', amount: '15' })
  })

  it('no sales means realized is a genuine zero; sales with unknown cost are unavailable', () => {
    expect(computeFigures([pos()]).realized).toMatchObject({ state: 'known', amount: '0' })
    const f = computeFigures([pos({ soldCount: 2, soldIncompleteCount: 2, realizedComplete: false })])
    expect(f.realized.state).toBe('unavailable')
    expect(f.realized.amount).toBeNull()
  })

  it('a mix of complete and incomplete sales is partial', () => {
    const f = computeFigures([pos({ soldCount: 2, soldIncompleteCount: 1, realizedKnown: '30', realizedComplete: false })])
    expect(f.realized).toMatchObject({ state: 'partial', amount: '30', covered: 1, total: 2 })
  })

  it('a fully sold token still reports its realized result', () => {
    const f = computeFigures([pos({ quantity: '0', value: '0', unrealized: '0', soldCount: 1, realizedKnown: '-40' })])
    expect(f.realized).toMatchObject({ state: 'known', amount: '-40' })
    expect(f.heldCount).toBe(0)
    expect(f.value.state).toBe('known')
  })

  it('tokens left out of the engine (no exchange rate) can never look complete', () => {
    const f = computeFigures([pos()], 1)
    expect(f.value.state).toBe('partial')
    expect(computeFigures([], 1).value.state).toBe('unavailable')
  })

  it('older payloads without sale counts degrade safely', () => {
    const old = { quantity: '1', value: '5', unrealized: '1', realizedKnown: '0', realizedComplete: false }
    expect(computeFigures([old]).realized.state).toBe('unavailable')
  })

  it('total is never "known" while a part is missing', () => {
    const f = computeFigures([pos(), pos({ value: null, unrealized: null })])
    expect(f.total.state).toBe('partial')
  })
})

describe('engine feeds the figures end to end', () => {
  const ev = (id: string, type: TradeEvent['type'], at: string, o: Partial<TradeEvent> = {}): TradeEvent =>
    ({ id, assetId: 'a', type, at, quantity: '10', consideration: '100', fee: '0', ...o })

  it('counts sales and flags an unknown-cost sale', () => {
    const s = summarizePortfolio([ev('o', 'OPENING', '2026-01-01T00:00:00Z', { basis: null }), ev('s', 'SELL', '2026-02-01T00:00:00Z', { quantity: '4' })], {})
    const p = s.positions[0]!
    expect(p.soldCount).toBe(1)
    expect(p.soldIncompleteCount).toBe(1)
    const f = computeFigures(s.positions)
    expect(f.realized.state).toBe('unavailable')
    expect(f.value.state).toBe('unavailable')
  })

  it('a clean buy then sell is fully known', () => {
    const s = summarizePortfolio([ev('b', 'BUY', '2026-01-01T00:00:00Z'), ev('s', 'SELL', '2026-02-01T00:00:00Z', { quantity: '4', consideration: '60' })], { a: { price: '12' } })
    const f = computeFigures(s.positions)
    expect(f.realized).toMatchObject({ state: 'known', amount: '20' })
    expect(f.unrealized).toMatchObject({ state: 'known', amount: '12' })
    expect(f.value).toMatchObject({ state: 'known', amount: '72' })
  })
})
