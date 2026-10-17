import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const asset = { id: 'MEC', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null }
const pos = (o: Record<string, unknown> = {}) => ({
  assetId: 'MEC', quantity: '60', knownRemainingBasis: '60600', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], soldCount: 0, soldIncompleteCount: 0, price: null, value: null, unrealized: null, ...o,
})
const summary = (position = pos(), o: Record<string, unknown> = {}) => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: {
    positions: [position], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0',
    unpricedAssets: ['MEC'], unknownBasisAssets: [], unresolvedAssets: [], partial: true, ...o,
  },
})
const point = (t: string, o: Record<string, unknown> = {}) => ({ t, costBasis: '60600', realized: '0', value: null, priced: 0, held: 1, complete: true, ...o })
const perf = (points: unknown[], period: Record<string, unknown> = {}) => ({
  currency: 'PKR', from: '2026-01-01T00:00:00.000Z', to: '2026-10-16T00:00:00.000Z', fxUnavailableAssets: [], points,
  period: {
    realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null,
    gain: null, gainUnavailableReason: 'A price is missing at the start or the end of this period.', returnPct: null, returnMethod: 'MODIFIED_DIETZ', ...period,
  },
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset])
  api.summary.mockResolvedValue(summary())
  api.listEvents.mockResolvedValue([])
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})

describe('the metrics use plain, exact names', () => {
  it('shows the five period figures', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z'), point('2026-10-16T00:00:00Z')]))
    render(<PortfolioPanel />)
    for (const label of ['Buy Costs + Fees', 'Sales Proceeds After Fees', 'Portfolio Value Change After Cash Flows', 'Percentage Return']) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('Known Realized Profit / Loss')).toBeInTheDocument() // the period figure; the headline card is called Realized Profit / Loss
  })

  it('a period with sales whose cost is not recorded says so instead of printing zero', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z')], { realized: '0', realizedComplete: false }))
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    const card = screen.getByText('Known Realized Profit / Loss').closest('div')!
    expect(within(card).getByText('Not known yet')).toBeInTheDocument()
    expect(within(card).queryByText(/PKR/)).toBeNull()
  })

  it('a period with partly known sales shows the known part with its caveat', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z')], { realized: '300', realizedComplete: false }))
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    expect(screen.getByText('Leaves out sales of units whose cost is not recorded')).toBeInTheDocument()
    expect(screen.getByText('PKR +300.00')).toBeInTheDocument()
  })

  it('a period with no sales at all is a genuine zero', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z')], { realized: '0', realizedComplete: true }))
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    expect(screen.getAllByText('PKR 0.00').length).toBeGreaterThan(0)
  })
})

describe('charts that have nothing to draw say what is missing and offer the fix', () => {
  it('held but never priced: explains it, draws no value line, and Add a price opens the price form', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z'), point('2026-10-16T00:00:00Z')]))
    const user = userEvent.setup()
    const { container } = render(<PortfolioPanel />)
    expect(await screen.findByText(/No prices were recorded for what you held/)).toBeInTheDocument()
    expect(screen.getByText(/never estimated|rather than being estimated/)).toBeInTheDocument()
    expect(container.querySelector('svg[aria-label="Portfolio Value Over Time"] polyline')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add a price' }))
    expect(await screen.findByLabelText(/Price per unit/)).toBeInTheDocument()
  })

  it('priced on some dates only: no total is drawn for the unpriced ones, and it says why', async () => {
    api.performance.mockResolvedValue(perf([
      point('2026-01-01T00:00:00Z', { priced: 0 }),
      point('2026-10-16T00:00:00Z', { priced: 0 }),
      point('2026-10-17T00:00:00Z', { priced: 1, held: 2 }),
    ]))
    render(<PortfolioPanel />)
    expect(await screen.findByText(/at least one token you held had no price/)).toBeInTheDocument()
  })

  it('nothing held in the period: says so and offers no pointless action', async () => {
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z', { held: 0, costBasis: '0' })]))
    render(<PortfolioPanel />)
    expect(await screen.findByText(/You held nothing in this period/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a price' })).toBeNull()
  })

  it('cost not recorded: explains the empty cost chart and Review history opens the token', async () => {
    api.summary.mockResolvedValue(summary(pos({ basisComplete: false }), { unknownBasisAssets: ['MEC'], unpricedAssets: [] }))
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z', { costBasis: null, realized: '0' })]))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    expect(await screen.findByText(/The remaining-cost line is blank because the cost of what you held is not recorded/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review history' }))
    expect(await screen.findByRole('heading', { name: 'Meta Earth' })).toBeInTheDocument()
  })

  it('no fix is offered when there is nothing to fix (all tokens priced)', async () => {
    api.summary.mockResolvedValue(summary(pos(), { unpricedAssets: [], partial: false }))
    api.performance.mockResolvedValue(perf([point('2026-01-01T00:00:00Z', { held: 1, priced: 0 })]))
    render(<PortfolioPanel />)
    expect(await screen.findByText(/No prices were recorded for what you held/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a price' })).toBeNull()
  })
})

describe('charts keep an accessible table of the same data', () => {
  it('offers the cost and realized series as a table, with gaps listed as not known', async () => {
    api.performance.mockResolvedValue(perf([
      point('2026-01-01T00:00:00Z', { costBasis: '100', realized: '0' }),
      point('2026-01-02T00:00:00Z', { costBasis: null, realized: '5' }),
    ]))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findAllByText('Cost and Realized Profit Over Time')
    await user.click(screen.getAllByText('View the data as a table')[0]!)
    expect(screen.getAllByRole('table', { hidden: true }).some((t) => within(t).queryByText('Not known'))).toBe(true)
  })
})
