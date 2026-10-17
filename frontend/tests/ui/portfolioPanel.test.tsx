import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

const emptyPerf = {
  currency: 'PKR', from: '2026-01-01T00:00:00Z', to: '2026-10-16T00:00:00Z', fxUnavailableAssets: [], points: [],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null, gain: null, gainUnavailableReason: 'A price is missing at the start or the end of this period.', returnPct: null, returnMethod: 'MODIFIED_DIETZ' },
}


import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const dto = (over = {}) => ({
  id: 'a1', name: 'Alpha', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', ...over,
})

const emptySummary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T00:00:00Z',
  summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.summary.mockResolvedValue(emptySummary)
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})

describe('PortfolioPanel', () => {
  it('shows loading, then the empty state, with the wallet section still present', async () => {
    api.listAssets.mockResolvedValue([])
    render(<PortfolioPanel walletSection={<button>Deposit</button>} />)
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
    expect(await screen.findByText('No tracked tokens yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeInTheDocument()
  })

  it('shows an error with retry and recovers', async () => {
    const user = userEvent.setup()
    api.listAssets.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([dto()])
    render(<PortfolioPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
  })

  it('adds a name-only token through the API with the cleaned payload', async () => {
    const user = userEvent.setup()
    api.listAssets.mockResolvedValue([])
    api.addAsset.mockResolvedValue(dto({ id: 'n1', name: 'Meta Earth' }))
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add asset' }))
    await user.type(screen.getByLabelText('Token name'), '  Meta   Earth ')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(api.addAsset).toHaveBeenCalledWith({ name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null })
    expect(await screen.findByText('Meta Earth')).toBeInTheDocument()
  })

  it('does not call the API for invalid input', async () => {
    const user = userEvent.setup()
    api.listAssets.mockResolvedValue([])
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add asset' }))
    await user.type(screen.getByLabelText('Token name'), 'X')
    await user.type(screen.getByLabelText(/Official website/), 'javascript:alert(1)')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(api.addAsset).not.toHaveBeenCalled()
  })

  it('keeps the form open and shows the server message if saving fails', async () => {
    const user = userEvent.setup()
    api.listAssets.mockResolvedValue([])
    api.addAsset.mockRejectedValue(new Error('You can track up to 200 custom tokens'))
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add asset' }))
    await user.type(screen.getByLabelText('Token name'), 'X')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(await screen.findByText('You can track up to 200 custom tokens')).toBeInTheDocument()
    expect(screen.getByLabelText('Token name')).toHaveValue('X')
  })

  it('two tokens with identical name, symbol and link stay as two separate entries', async () => {
    const same = { name: 'Alpha', symbol: 'ALP', sourceUrl: 'https://alpha.example/' }
    api.listAssets.mockResolvedValue([dto({ id: 'a1', ...same }), dto({ id: 'a2', ...same })])
    render(<PortfolioPanel />)
    expect(await screen.findAllByRole('button', { name: /^Alpha/ })).toHaveLength(2)
  })

  it('editing details updates the name in place and calls PATCH with the asset id only', async () => {
    const user = userEvent.setup()
    api.listAssets.mockResolvedValue([dto({ id: 'a1', name: 'Old Name' }), dto({ id: 'a2', name: 'Other' })])
    api.updateAsset.mockResolvedValue(dto({ id: 'a1', name: 'New Name' }))
    render(<PortfolioPanel />)
    await user.click(await screen.findByText('Old Name'))
    await user.click(screen.getByRole('button', { name: 'Edit details' }))
    expect(screen.getByText(/does not change your quantities, transactions, cost basis or profit and loss/i)).toBeInTheDocument()
    const name = screen.getByLabelText('Token name')
    await user.clear(name)
    await user.type(name, 'New Name')
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    expect(api.updateAsset).toHaveBeenCalledWith('a1', { name: 'New Name', symbol: null, sourceUrl: null, network: null, contractAddress: null })
    expect(await screen.findByRole('heading', { name: 'New Name' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /back to portfolio/i }))
    expect(screen.getByText('Other')).toBeInTheDocument()
  })
})
