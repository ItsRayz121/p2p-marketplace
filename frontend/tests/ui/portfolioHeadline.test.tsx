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
  it('held but unpriced and unknown cost: Unavailable, and no PKR 0.00 anywhere', () => {
    render(<PortfolioHeadline
      data={data([pos('a', { quantity: '10', basisComplete: false, realizedComplete: false, soldCount: 1, soldIncompleteCount: 1 })], { partial: true, unpricedAssets: ['a'], unknownBasisAssets: ['a'] })}
      trackedHeld={1}
    />)
    // Portfolio value, total profit/loss, profit from sales and holding profit/loss.
    expect(screen.getAllByText('Unavailable')).toHaveLength(4)
    expect(screen.queryByText(/PKR [+-]?0\.00/)).toBeNull()
  })

  it('nothing held and nothing sold is a genuine zero', () => {
    render(<PortfolioHeadline data={data([])} trackedHeld={0} />)
    expect(screen.getAllByText('PKR 0.00').length).toBeGreaterThan(0)
    expect(screen.getByText('Assets Held')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).toBeNull()
  })

  it('a partly priced portfolio shows the sum with a Partial chip', () => {
    render(<PortfolioHeadline
      data={data(
        [pos('a', { quantity: '10', value: '100', unrealized: '20' }), pos('b', { quantity: '5' })],
        { partial: true, pricedValue: '100', knownUnrealized: '20', knownTotalPnl: '20', unpricedAssets: ['b'] },
      )}
      trackedHeld={2}
    />)
    expect(screen.getByText('PKR 100.00')).toBeInTheDocument()
    // Value, total profit/loss and holding profit/loss each cover 1 of 2 tokens.
    expect(screen.getAllByText(/Partial · 1\/2/).length).toBe(3)
  })

  it('a token whose cost has no exchange rate stays counted: its value shows, its profit is not invented', () => {
    render(<PortfolioHeadline
      data={data([pos('a', { quantity: '10', value: '100', unrealized: null, basisComplete: false })], { partial: true, pricedValue: '100', unknownBasisAssets: ['a'] }, { fxUnavailableAssets: ['a'] })}
      trackedHeld={1}
    />)
    expect(screen.getByText('PKR 100.00')).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByText('Value unavailable')).toBeNull()
  })

  it('the sales / holding split sits behind Breakdown and is labelled in plain words', () => {
    render(<PortfolioHeadline
      data={data([pos('a', { quantity: '10', value: '100', unrealized: '20', realizedKnown: '5', soldCount: 1 })], { pricedValue: '100', knownUnrealized: '20', knownRealized: '5', knownTotalPnl: '25' })}
      trackedHeld={1}
    />)
    expect(screen.getByText('PKR +25.00')).toBeInTheDocument()
    expect(screen.getByText('Breakdown')).toBeInTheDocument()
    expect(screen.getByText('Profit from Sales')).toBeInTheDocument()
    expect(screen.getByText('Holding Profit / Loss')).toBeInTheDocument()
    expect(screen.getByText('PKR +5.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +20.00')).toBeInTheDocument()
  })
})
