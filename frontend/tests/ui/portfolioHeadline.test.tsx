import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PortfolioHeadline } from '@/components/portfolio/PortfolioHeadline'

const pos = (assetId: string, o: Record<string, unknown> = {}) => ({
  assetId, quantity: '0', knownRemainingBasis: '0', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], soldCount: 0, soldIncompleteCount: 0, price: null, value: null, unrealized: null, ...o,
})
const data = (positions: unknown[], o: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: {
    positions, pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0',
    unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false, ...o,
  },
  ...root,
}) as never

describe('headline never prints 0 for something that is not known', () => {
  it('held but unpriced and unknown cost: no PKR 0.00 anywhere', () => {
    render(<PortfolioHeadline
      data={data([pos('a', { quantity: '10', basisComplete: false, realizedComplete: false, soldCount: 1, soldIncompleteCount: 1 })], { partial: true, unpricedAssets: ['a'], unknownBasisAssets: ['a'] })}
      trackedHeld={1} trackedTotal={1}
    />)
    expect(screen.getByText('Value unavailable')).toBeInTheDocument()
    expect(screen.getAllByText('Not known yet')).toHaveLength(2)
    expect(screen.queryByText(/PKR [+-]?0\.00/)).toBeNull()
  })

  it('nothing held and nothing sold is a genuine zero', () => {
    render(<PortfolioHeadline data={data([])} trackedHeld={0} trackedTotal={0} />)
    expect(screen.getAllByText('PKR 0.00').length).toBeGreaterThan(0)
    expect(screen.getByText('No sales yet')).toBeInTheDocument()
    expect(screen.getByText('0 tokens tracked')).toBeInTheDocument()
  })

  it('a partly priced portfolio shows the sum with a Partial badge', () => {
    render(<PortfolioHeadline
      data={data(
        [pos('a', { quantity: '10', value: '100', unrealized: '20' }), pos('b', { quantity: '5' })],
        { partial: true, pricedValue: '100', knownUnrealized: '20', unpricedAssets: ['b'] },
      )}
      trackedHeld={2} trackedTotal={2}
    />)
    expect(screen.getByText('PKR 100.00')).toBeInTheDocument()
    expect(screen.getAllByText(/Partial · 1 of 2 tokens/).length).toBe(2)
  })

  it('a token left out for want of an exchange rate keeps the totals partial, never complete', () => {
    render(<PortfolioHeadline
      data={data([pos('a', { quantity: '10', value: '100', unrealized: '20' })], { partial: true, pricedValue: '100', knownUnrealized: '20' }, { fxUnavailableAssets: ['b'] })}
      trackedHeld={1} trackedTotal={2}
    />)
    expect(screen.getAllByText(/Partial · 1 of 2 tokens/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Realized plus unrealized/)).toBeNull()
  })

})
