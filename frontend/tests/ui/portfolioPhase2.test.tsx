import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortfolioTab } from '@/components/portfolio/PortfolioTab'
import { AllocationBar } from '@/components/portfolio/AllocationBar'
import { resolvePeriod } from '@/lib/portfolio/periods'

const asset = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, name, symbol: name.slice(0, 3).toUpperCase(), sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', ...o,
})
const pos = (assetId: string, o: Record<string, unknown> = {}) => ({
  assetId, quantity: '10', knownRemainingBasis: '100', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], soldCount: 0, soldIncompleteCount: 0, price: '10', value: '100', unrealized: '0', ...o,
})
const sum = (positions: unknown[]) => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: new Date().toISOString(),
  summary: {
    positions, pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0',
    unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false,
  },
})
const ev = (id: string, occurredAt: string, o: Record<string, unknown> = {}) => ({
  id, assetId: 'a', type: 'BUY', occurredAt, quantity: '1', consideration: '10', fee: null, basis: null, zeroCost: false, quote: 'PKR',
  fxRate: null, fxSource: null, note: id, source: 'manual', voided: false, voidReason: null, ...o,
})

describe('allocation', () => {
  it('splits only priced holdings and names the tokens that have no price', () => {
    const assets = [asset('a', 'Alpha'), asset('b', 'Beta'), asset('c', 'Gamma')]
    render(<AllocationBar assets={assets as never} currency="PKR" positions={[pos('a', { value: '300' }), pos('b', { value: '100' }), pos('c', { value: null })] as never} />)
    const list = screen.getByRole('list')
    expect(within(list).getByText('75.0%')).toBeInTheDocument()
    expect(within(list).getByText('25.0%')).toBeInTheDocument()
    expect(screen.getByText(/1 token has no price and is not included/)).toBeInTheDocument()
  })
  it('is not drawn for fewer than two priced tokens', () => {
    const { container } = render(<AllocationBar assets={[asset('a', 'Alpha')] as never} currency="PKR" positions={[pos('a')] as never} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('token page', () => {
  const tab = (a: Record<string, unknown>, events: unknown[]) => (
    <PortfolioTab
      assets={[asset('a', 'Alpha', a)] as never}
      summary={sum([pos('a')]) as never}
      loadEvents={async () => events as never}
      onEditAsset={async () => {}}
    />
  )
  it('lists the newest entry first', async () => {
    const user = userEvent.setup()
    render(tab({}, [ev('old', '2026-07-01T10:00:00Z'), ev('mid', '2026-08-01T10:00:00Z'), ev('new', '2026-09-01T10:00:00Z')]))
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    const table = await screen.findByRole('table')
    const notes = within(table).getAllByRole('row').slice(1).map((r) => r.textContent ?? '')
    expect(notes[0]).toContain('new')
    expect(notes[1]).toContain('mid')
    expect(notes[2]).toContain('old')
  })
  it('offers Edit details for a custom token but not for one listed on RupChain', async () => {
    const user = userEvent.setup()
    const { unmount } = render(tab({}, []))
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Edit details' })).toBeInTheDocument()
    unmount()
    render(tab({ linkedToRupChainToken: true }, []))
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    await screen.findByRole('menuitem', { name: 'View details' })
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull()
  })
})

describe('periods', () => {
  it('1Y starts 365 days before now', () => {
    const now = new Date('2026-10-17T00:00:00Z')
    const r = resolvePeriod('1y', now)
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(now.getTime() - r.from!.getTime()).toBe(365 * 86_400_000)
  })
})
