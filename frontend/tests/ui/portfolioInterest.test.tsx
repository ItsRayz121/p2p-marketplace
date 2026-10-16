import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(), exportAll: vi.fn(),
  suggestListing: vi.fn(), withdrawListingSuggestion: vi.fn(),
}))
const adminApi = vi.hoisted(() => ({ interest: vi.fn() }))
vi.mock('@/lib/api', () => ({
  portfolioApi: api,
  portfolioAdminApi: adminApi,
  ApiError: class ApiError extends Error {},
}))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { ListingInterestBlock, INTEREST_EXPLAINER } from '@/components/portfolio/ListingInterestBlock'
import AdminPortfolioInterestPage from '@/app/admin/portfolio-interest/page'

const asset = (o: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Meta Earth', symbol: 'MEC', sourceUrl: null, network: 'BEP20', contractAddress: '0xabc', createdAt: '2026-10-16T00:00:00Z',
  archivedAt: null, listingInterest: false, linkedToRupChainToken: false, ...o,
})

describe('ListingInterestBlock', () => {
  it('explains exactly what is shared and offers an explicit action', () => {
    render(<ListingInterestBlock asset={asset()} onSuggest={vi.fn()} onWithdraw={vi.fn()} />)
    expect(screen.getByText(INTEREST_EXPLAINER)).toBeInTheDocument()
    expect(INTEREST_EXPLAINER).toMatch(/never see your name, holdings, records or notes/)
    expect(INTEREST_EXPLAINER).toMatch(/does not list the token/)
    expect(INTEREST_EXPLAINER).toMatch(/withdraw at any time/)
    expect(screen.getByRole('button', { name: 'I would like this token listed on RupChain' })).toBeInTheDocument()
  })
  it('calls the suggestion handler only when the button is pressed', async () => {
    const onSuggest = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ListingInterestBlock asset={asset()} onSuggest={onSuggest} onWithdraw={vi.fn()} />)
    expect(onSuggest).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /would like this token listed/ }))
    expect(onSuggest).toHaveBeenCalledWith('a1')
  })
  it('a token without a network and contract cannot be suggested, and the page says why', () => {
    render(<ListingInterestBlock asset={asset({ network: null, contractAddress: null })} onSuggest={vi.fn()} onWithdraw={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /would like this token listed/ })).toBeNull()
    expect(screen.getByText(/A name alone cannot identify a token/)).toBeInTheDocument()
  })
  it('once suggested it shows that, and offers to withdraw', async () => {
    const onWithdraw = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ListingInterestBlock asset={asset({ listingInterest: true })} onSuggest={vi.fn()} onWithdraw={onWithdraw} />)
    expect(screen.getByRole('status')).toHaveTextContent('You suggested this token.')
    await user.click(screen.getByRole('button', { name: 'Withdraw my suggestion' }))
    expect(onWithdraw).toHaveBeenCalledWith('a1')
  })
  it('is not shown for a token that is already available on RupChain, or if the handlers are absent', () => {
    const { container, rerender } = render(<ListingInterestBlock asset={asset({ linkedToRupChainToken: true })} onSuggest={vi.fn()} onWithdraw={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<ListingInterestBlock asset={asset()} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('shows the server message when it fails and stays usable', async () => {
    const user = userEvent.setup()
    render(<ListingInterestBlock asset={asset()} onSuggest={vi.fn().mockRejectedValue(new Error('Verify your email address to suggest a token.'))} onWithdraw={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /would like this token listed/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Verify your email address')
    expect(screen.getByRole('button', { name: /would like this token listed/ })).toBeEnabled()
  })
})

describe('inside the token view', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset())
    api.listAssets.mockResolvedValue([asset()])
    api.summary.mockResolvedValue({
      currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T00:00:00Z',
      summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
    })
    api.listEvents.mockResolvedValue([])
    api.performance.mockResolvedValue({})
    api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
  })

  it('suggesting and withdrawing round-trips through the API and updates the screen', async () => {
    api.suggestListing.mockResolvedValue({ listingInterest: true })
    api.withdrawListingSuggestion.mockResolvedValue({ listingInterest: false })
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    await user.click(await screen.findByRole('button', { name: /would like this token listed/ }))
    expect(api.suggestListing).toHaveBeenCalledWith('a1')
    expect(await screen.findByText('You suggested this token.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Withdraw my suggestion' }))
    expect(api.withdrawListingSuggestion).toHaveBeenCalledWith('a1')
    expect(await screen.findByRole('button', { name: /would like this token listed/ })).toBeInTheDocument()
  })
  it('nothing is sent just by opening a token', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    await screen.findByText(/Suggest this token for listing/)
    expect(api.suggestListing).not.toHaveBeenCalled()
  })
  it('a token that mirrors a RupChain token is not offered for suggestion', async () => {
    api.listAssets.mockResolvedValue([asset({ linkedToRupChainToken: true })])
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    await screen.findByRole('button', { name: /back to portfolio/i })
    expect(screen.queryByText(/Suggest this token for listing/)).toBeNull()
  })
  it('editing the contract clears the suggestion shown here (the server withdraws it)', async () => {
    api.listAssets.mockResolvedValue([asset({ listingInterest: true })])
    api.updateAsset.mockResolvedValue({ ...asset(), contractAddress: '0xnew', listingInterest: undefined })
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    expect(await screen.findByText('You suggested this token.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit details' }))
    const contract = screen.getByLabelText(/Contract address/)
    await user.clear(contract)
    await user.type(contract, '0xnew')
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    expect(await screen.findByRole('button', { name: /would like this token listed/ })).toBeInTheDocument()
    expect(screen.queryByText('You suggested this token.')).toBeNull()
  })
})

describe('admin page', () => {
  beforeEach(() => adminApi.interest.mockReset())
  const report = (o: Record<string, unknown> = {}) => ({
    asOf: '2026-10-16T10:00:00Z', refreshesEvery: '1 hour', threshold: 20, suppressedGroups: 0, notice: 'n', groups: [], ...o,
  })

  it('shows anonymous groups only: network, contract, common name, rounded count, trend', async () => {
    adminApi.interest.mockResolvedValue(report({
      groups: [{ network: 'bep20', contract: '0xabc', approxAccounts: 30, commonName: 'Meta Earth', trend: 'rising' }, { network: 'solana', contract: 'So111', approxAccounts: 20, commonName: null, trend: 'steady' }],
      suppressedGroups: 4,
    }))
    render(<AdminPortfolioInterestPage />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Network', 'Contract', 'Commonly called', 'People (at least)', 'Last 30 days'])
    expect(within(table).getByText('Meta Earth')).toBeInTheDocument()
    expect(within(table).getByText('Varies')).toBeInTheDocument()
    expect(within(table).getByText('30')).toBeInTheDocument()
    expect(within(table).getByText('Rising')).toBeInTheDocument()
    expect(screen.getByText(/4 more tokens have some interest but are below the minimum and not shown/)).toBeInTheDocument()
    expect(screen.getByText(/does not approve a listing/)).toBeInTheDocument()
    expect(screen.getByText(/recorded in the audit log/)).toBeInTheDocument()
  })
  it('there is no way to see who suggested anything: no account, holdings or note columns', async () => {
    adminApi.interest.mockResolvedValue(report({ groups: [{ network: 'bep20', contract: '0xabc', approxAccounts: 25, commonName: null, trend: 'steady' }] }))
    render(<AdminPortfolioInterestPage />)
    await screen.findByRole('table')
    for (const word of [/user/i, /email/i, /holding/i, /amount/i, /note/i, /account name/i]) {
      expect(screen.queryByRole('columnheader', { name: word })).toBeNull()
    }
  })
  it('an empty result explains that nothing has reached the minimum yet', async () => {
    adminApi.interest.mockResolvedValue(report())
    render(<AdminPortfolioInterestPage />)
    expect(await screen.findByText(/No token has reached the minimum number of suggestions yet/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
  it('shows an error with retry', async () => {
    adminApi.interest.mockRejectedValueOnce(new Error('Forbidden')).mockResolvedValueOnce(report())
    const user = userEvent.setup()
    render(<AdminPortfolioInterestPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/No token has reached/)).toBeInTheDocument()
  })
})
