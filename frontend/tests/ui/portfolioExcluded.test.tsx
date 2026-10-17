import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), updateEvent: vi.fn(), eventHistory: vi.fn(),
  setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(), listExcluded: vi.fn(), recordExcluded: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { EXCLUDED_PAGE_SIZE } from '@/components/portfolio/ExcludedTradesView'

const summary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
}
const emptyPerf = {
  currency: 'PKR', from: '2026-01-01T00:00:00Z', to: '2026-10-16T00:00:00Z', fxUnavailableAssets: [], points: [],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null, gain: null, gainUnavailableReason: 'x', returnPct: null, returnMethod: 'MODIFIED_DIETZ' },
}
const report = { dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, hasImportedBefore: true, preview: [], skippedForLimit: 0,
  attention: [{ reason: 'disputed', count: 21 }, { reason: 'auto_completed', count: 5 }] }
const trade = (o: Record<string, unknown> = {}) => ({
  tradeId: 'tr1', tradeRef: 'CTM-1001', tokenName: 'Meta Earth', side: 'BUY', quantity: '100', consideration: '125000', quote: 'PKR',
  date: '2026-10-01T10:00:00.000Z', reason: 'disputed', recorded: false, canRecord: true, ...o,
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([])
  api.summary.mockResolvedValue(summary)
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue(report)
  api.listExcluded.mockResolvedValue({ total: 1, items: [trade()] })
})

async function openReview() {
  const user = userEvent.setup()
  render(<PortfolioPanel />)
  await user.click(await screen.findByRole('button', { name: /^Review/ }))
  await user.click(await screen.findByRole('button', { name: 'Review trades' }))
  return user
}

describe('reviewing trades that were left out', () => {
  it('is offered from the notice about trades that were not added, and shows each trade with its reason', async () => {
    await openReview()
    const table = await screen.findByRole('table')
    expect(within(table).getByText('CTM-1001')).toBeInTheDocument()
    expect(within(table).getByText('Meta Earth')).toBeInTheDocument()
    expect(within(table).getByText('Bought')).toBeInTheDocument()
    expect(within(table).getByText('125,000.00 PKR')).toBeInTheDocument()
    expect(within(table).getByText('in or after a dispute')).toBeInTheDocument()
    expect(api.listExcluded).toHaveBeenCalledWith(EXCLUDED_PAGE_SIZE, 0)
  })

  it('the Review center lists trades left out, with each reason, and offers the review only when the tracker can list them', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(await screen.findByText(/26 RupChain trades were not added/)).toBeInTheDocument()
    expect(screen.getByText(/21 trades: in or after a dispute/)).toBeInTheDocument()
    expect(screen.getByText(/5 trades: closed automatically/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review trades' })).toBeInTheDocument()
  })

  it('opening the record form scrolls it into view, focuses a field, and confirms after saving', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    window.scrollTo = vi.fn()
    api.recordExcluded.mockResolvedValue({})
    const user = await openReview()
    await user.click(await screen.findByRole('button', { name: /Record trade CTM-1001 by hand/ }))
    expect(scroll).toHaveBeenCalled()
    expect(screen.getByLabelText('Quantity')).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Recorded trade CTM-1001 in your portfolio.')).toBeInTheDocument()
  })

  it('says so plainly when nothing was left out', async () => {
    api.listExcluded.mockResolvedValue({ total: 0, items: [] })
    await openReview()
    expect(await screen.findByText(/already counted. Nothing was left out/)).toBeInTheDocument()
  })

  it('an unfinished trade cannot be recorded; a recorded one says so', async () => {
    api.listExcluded.mockResolvedValue({ total: 2, items: [trade({ tradeId: 'p', tradeRef: 'CTM-P', reason: 'in_progress', canRecord: false }), trade({ tradeId: 'r', tradeRef: 'CTM-R', recorded: true })] })
    await openReview()
    expect(await screen.findByText('Not finished yet')).toBeInTheDocument()
    expect(screen.getByText('Recorded by you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record trade/ })).toBeNull()
  })

  it('pages through a long list', async () => {
    api.listExcluded.mockImplementation(async (_l: number, offset: number) => ({ total: 30, items: [trade({ tradeId: `t${offset}`, tradeRef: `CTM-${offset}` })] }))
    const user = await openReview()
    expect(await screen.findByText('Showing 1 to 25 of 30')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Showing 26 to 30 of 30')).toBeInTheDocument()
    expect(api.listExcluded).toHaveBeenLastCalledWith(EXCLUDED_PAGE_SIZE, EXCLUDED_PAGE_SIZE)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('a failed load can be retried', async () => {
    api.listExcluded.mockRejectedValueOnce(new Error('Network down')).mockResolvedValue({ total: 1, items: [trade()] })
    const user = await openReview()
    expect(await screen.findByText(/Network down/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('CTM-1001')).toBeInTheDocument()
  })
})

describe('recording a left-out trade by hand', () => {
  it('prefills the form from the trade, locks the side, and sends the confirmed values for that trade', async () => {
    api.recordExcluded.mockResolvedValue({ id: 'e1' })
    const user = await openReview()
    await user.click(await screen.findByRole('button', { name: /Record trade CTM-1001/ }))
    // The side is fixed by the trade: no Buy / Sell switch, just its label.
    expect(screen.queryByRole('radio', { name: 'Sell' })).toBeNull()
    expect(screen.getByText('Buy')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('100')
    expect(screen.getByLabelText('Amount paid (PKR)')).toHaveValue('125000')
    expect(screen.getByText(/This trade can be recorded once/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Amount paid (PKR)'))
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '120000')
    api.listExcluded.mockResolvedValue({ total: 1, items: [trade({ recorded: true })] })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(api.recordExcluded).toHaveBeenCalledTimes(1))
    const [tradeId, input] = api.recordExcluded.mock.calls[0]!
    expect(tradeId).toBe('tr1')
    expect(input).toMatchObject({ type: 'BUY', quantity: '100', consideration: '120000', quote: 'PKR', occurredAt: '2026-10-01T10:00:00.000Z' })
    expect(api.addEvent).not.toHaveBeenCalled()
    expect(await screen.findByText('Recorded by you')).toBeInTheDocument()
    expect(screen.queryByLabelText('Quantity')).toBeNull()
  })

  it('a rejected record keeps the form open with the message, so nothing is lost', async () => {
    api.recordExcluded.mockRejectedValue(new Error('You already recorded this trade.'))
    const user = await openReview()
    await user.click(await screen.findByRole('button', { name: /Record trade CTM-1001/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('You already recorded this trade.')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('100')
  })

  it('a sale is shown as sold and prefilled as a sell', async () => {
    api.listExcluded.mockResolvedValue({ total: 1, items: [trade({ side: 'SELL', reason: 'auto_completed' })] })
    const user = await openReview()
    expect(await screen.findByText('Sold')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Record trade CTM-1001/ }))
    expect(screen.queryByRole('radio', { name: 'Buy' })).toBeNull()
    expect(screen.getByText('Sell')).toBeInTheDocument()
    expect(screen.getByLabelText('Amount received (PKR)')).toHaveValue('125000')
  })
})
