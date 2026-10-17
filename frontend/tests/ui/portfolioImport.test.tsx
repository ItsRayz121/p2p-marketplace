import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const asset = { id: 'a1', name: 'Meta Earth', symbol: 'MEC', sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null }
const summary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
}
const report = (o: Record<string, unknown> = {}) => ({
  dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0, ...o,
})
const preview = [
  { tradeRef: 'CTM-1', tokenName: 'Meta Earth', type: 'BUY', quantity: '100', consideration: '125000', quote: 'PKR', date: '2026-10-01T10:00:00Z' },
  { tradeRef: 'CTM-2', tokenName: 'Sidra', type: 'SELL', quantity: '5', consideration: '40', quote: 'USDT', date: '2026-10-02T10:00:00Z' },
]

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset])
  api.summary.mockResolvedValue(summary)
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue({})
  api.importCtm.mockResolvedValue(report())
})

describe('first time: asks before adding anything', () => {
  it('shows a preview and does NOT import until the user says yes', async () => {
    api.importCtm.mockResolvedValue(report({ created: 2, preview }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    expect(await screen.findByText(/2 completed RupChain trades are ready to add/)).toBeInTheDocument()
    expect(api.importCtm).toHaveBeenCalledTimes(1)
    expect(api.importCtm).toHaveBeenCalledWith(true) // dry run only
    expect(screen.getByText(/does not change the trade, your wallet or any payment/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review the trades' }))
    expect(screen.getByText(/Bought 100 Meta Earth/)).toBeInTheDocument()
    expect(screen.getByText(/Sold 5 Sidra/)).toBeInTheDocument()
    expect(screen.getByText(/40.00 USDT/)).toBeInTheDocument()
  })
  it('"Add these trades" applies the import, refreshes the tracker and hides the prompt', async () => {
    api.importCtm.mockResolvedValueOnce(report({ created: 2, preview })).mockResolvedValueOnce(report({ dryRun: false, created: 2, hasImportedBefore: true }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add these trades' }))
    await vi.waitFor(() => expect(api.importCtm).toHaveBeenLastCalledWith(false))
    await vi.waitFor(() => expect(screen.queryByText(/ready to add/)).toBeNull())
    expect(api.listAssets.mock.calls.length).toBeGreaterThanOrEqual(2) // refreshed
  })
  it('"Not now" hides the prompt without importing', async () => {
    api.importCtm.mockResolvedValue(report({ created: 1, preview: [preview[0]] }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(/ready to add/)).toBeNull()
    expect(api.importCtm).toHaveBeenCalledTimes(1)
  })
  it('shows an error and keeps the prompt if adding fails', async () => {
    api.importCtm.mockResolvedValueOnce(report({ created: 1, preview: [preview[0]] })).mockRejectedValueOnce(new Error('Try later'))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add these trades' }))
    expect(await screen.findByText('Try later')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add these trades' })).toBeEnabled()
  })
})

describe('after the first import: kept in sync automatically', () => {
  it('new settled trades are added without asking', async () => {
    api.importCtm.mockResolvedValueOnce(report({ created: 1, hasImportedBefore: true, preview: [preview[0]] }))
      .mockResolvedValueOnce(report({ dryRun: false, created: 1, hasImportedBefore: true }))
    render(<PortfolioPanel />)
    await vi.waitFor(() => expect(api.importCtm).toHaveBeenCalledTimes(2))
    expect(api.importCtm.mock.calls.map((c) => c[0])).toEqual([true, false])
    expect(screen.queryByRole('button', { name: 'Add these trades' })).toBeNull()
  })
  it('a trade that stops qualifying is voided automatically too', async () => {
    api.importCtm.mockResolvedValueOnce(report({ voided: 1, hasImportedBefore: true })).mockResolvedValueOnce(report({ dryRun: false, voided: 1, hasImportedBefore: true }))
    render(<PortfolioPanel />)
    await vi.waitFor(() => expect(api.importCtm).toHaveBeenCalledTimes(2))
  })
  it('nothing new means no second call', async () => {
    api.importCtm.mockResolvedValue(report({ hasImportedBefore: true, alreadyImported: 3 }))
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await vi.waitFor(() => expect(api.importCtm).toHaveBeenCalledTimes(1))
  })
})

describe('trades that need attention', () => {
  it('lists why each group was left out, in plain language, without importing them', async () => {
    api.importCtm.mockResolvedValue(report({
      hasImportedBefore: true,
      attention: [{ reason: 'auto_completed', count: 2 }, { reason: 'disputed', count: 1 }, { reason: 'in_progress', count: 1 }],
    }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(await screen.findByText('3 RupChain trades were not added')).toBeInTheDocument()
    expect(screen.getByText(/2 trades: closed automatically because the buyer never confirmed receipt/)).toBeInTheDocument()
    expect(screen.getByText(/1 trade: in or after a dispute/)).toBeInTheDocument()
    expect(api.importCtm).toHaveBeenCalledTimes(1)
  })
  it('warns when the tracker limit stopped some trades', async () => {
    api.importCtm.mockResolvedValue(report({ skippedForLimit: 3 }))
    render(<PortfolioPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('3 trades were skipped')
  })
  it('a failing import check never blocks the tracker itself', async () => {
    api.importCtm.mockRejectedValue(new Error('boom'))
    render(<PortfolioPanel />)
    expect(await screen.findByRole('button', { name: /^Meta Earth/ })).toBeInTheDocument()
    expect(screen.queryByText('boom')).toBeNull()
  })
})

describe('imported entries are read-only and voided ones are not counted', () => {
  const ev = (o: Record<string, unknown>) => ({
    id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: '2026-10-01T10:00:00Z', quantity: '100', consideration: '125000', fee: '0',
    basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: 'Imported from RupChain trade CTM-1',
    source: 'ctm', voided: false, voidReason: null, ...o,
  })
  async function openHistory(events: unknown[]) {
    api.listEvents.mockResolvedValue(events)
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    return await screen.findByRole('table')
  }
  it('an imported entry is labelled as a RupChain trade and has no Remove button', async () => {
    const table = await openHistory([ev({})])
    expect(within(table).getByText('· RupChain trade')).toBeInTheDocument()
    expect(within(table).getByText('Read-only')).toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: /Remove/ })).toBeNull()
  })
  it('manual entries next to it can still be removed', async () => {
    const table = await openHistory([ev({}), ev({ id: 'e2', source: 'manual', note: null })])
    expect(within(table).getAllByRole('button', { name: /Remove/ })).toHaveLength(1)
  })
  it('a voided entry says it is not counted and why', async () => {
    const table = await openHistory([ev({ voided: true, voidReason: 'disputed' })])
    expect(within(table).getByText(/Not counted: in or after a dispute/)).toBeInTheDocument()
  })
  it('an unknown void reason still reads sensibly', async () => {
    const table = await openHistory([ev({ voided: true, voidReason: 'something_new' })])
    expect(within(table).getByText(/Not counted: it no longer qualifies/)).toBeInTheDocument()
  })
})
