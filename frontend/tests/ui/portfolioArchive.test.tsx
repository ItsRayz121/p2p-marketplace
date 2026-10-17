import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

const emptyPerf = {
  currency: 'PKR', from: '2026-01-01T00:00:00Z', to: '2026-10-16T00:00:00Z', fxUnavailableAssets: [], points: [],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null, gain: null, gainUnavailableReason: 'A price is missing at the start or the end of this period.', returnPct: null, returnMethod: 'MODIFIED_DIETZ' },
}


import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const asset = (id: string, name: string, over = {}) => ({
  id, name, symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null, ...over,
})
const emptySummary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T00:00:00Z',
  summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
}
// Archive and delete live in the token's three-dot menu.
async function pickFromMenu(user: ReturnType<typeof userEvent.setup>, item: string) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }))
  await user.click(await screen.findByRole('menuitem', { name: item }))
}
const ev = { id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: '2026-01-01T10:00:00Z', quantity: '1', consideration: '10', fee: '0', basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null }

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset('a1', 'Alpha'), asset('a2', 'Beta')])
  api.summary.mockResolvedValue(emptySummary)
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})

describe('archive and restore', () => {
  it('asks the API for archived tokens too, so history labels still resolve', async () => {
    render(<PortfolioPanel />)
    await screen.findByText('Alpha')
    expect(api.listAssets).toHaveBeenCalledWith(true)
  })
  it('archiving returns to the list, hides the token, and offers it under "Show archived"', async () => {
    api.archiveAsset.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await pickFromMenu(user, 'Archive asset')
    expect(api.archiveAsset).not.toHaveBeenCalled() // explained first, nothing changes until confirmed
    await user.click(await screen.findByRole('button', { name: 'Archive asset' }))
    await vi.waitFor(() => expect(api.archiveAsset).toHaveBeenCalledWith('a1'))
    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Alpha/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show archived tokens (1)' }))
    expect(screen.getByRole('button', { name: /Alpha.*Archived/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide archived tokens' }))
    expect(screen.queryByRole('button', { name: /^Alpha/ })).toBeNull()
  })
  it('an archived token is read-only until restored', async () => {
    api.listAssets.mockResolvedValue([asset('a1', 'Alpha', { archivedAt: '2026-10-01T00:00:00Z' })])
    api.unarchiveAsset.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Show archived tokens (1)' }))
    await user.click(screen.getByRole('button', { name: /^Alpha/ }))
    expect(await screen.findByText(/still counts in your totals/)).toBeInTheDocument()
    for (const name of ['Record Transaction', 'Update price']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Archive asset' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Add previous holdings' })).toBeNull()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(api.unarchiveAsset).toHaveBeenCalledWith('a1')
    expect(await screen.findByRole('button', { name: 'Record Transaction' })).toBeInTheDocument()
    expect(screen.queryByText(/still counts in your totals/)).toBeNull()
  })
  it('shows a clear message when every token is archived', async () => {
    api.listAssets.mockResolvedValue([asset('a1', 'Alpha', { archivedAt: '2026-10-01T00:00:00Z' })])
    render(<PortfolioPanel />)
    expect(await screen.findByText(/All your tracked tokens are archived/)).toBeInTheDocument()
  })
  it('keeps the token open and shows the error if archiving fails', async () => {
    api.archiveAsset.mockRejectedValue(new Error('Network down'))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await pickFromMenu(user, 'Archive asset')
    await user.click(await screen.findByRole('button', { name: 'Archive asset' }))
    expect(await screen.findByText('Network down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to portfolio/i })).toBeInTheDocument()
  })
})

describe('delete', () => {
  it('is offered only when the token has no records, needs a second confirmation, then removes it', async () => {
    api.deleteAsset.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await pickFromMenu(user, 'Delete token')
    expect(api.deleteAsset).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep token' }))
    expect(api.deleteAsset).not.toHaveBeenCalled()
    await pickFromMenu(user, 'Delete token')
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(api.deleteAsset).toHaveBeenCalledWith('a1')
    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Alpha/ })).toBeNull()
  })
  it('a token with records cannot be deleted, only archived, and the page says why', async () => {
    api.listEvents.mockResolvedValue([ev])
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    expect(await screen.findByText(/can be archived but not deleted/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Delete token' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Archive asset' })).toBeInTheDocument()
  })
  it('shows the server message if the delete is refused', async () => {
    api.deleteAsset.mockRejectedValue(new Error('This token has records. Archive it instead so your history is kept.'))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Alpha/ }))
    await pickFromMenu(user, 'Delete token')
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(await screen.findByText(/Archive it instead/)).toBeInTheDocument()
  })
})
