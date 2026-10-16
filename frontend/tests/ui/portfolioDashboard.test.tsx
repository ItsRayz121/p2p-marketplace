import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), updateEvent: vi.fn(), eventHistory: vi.fn(),
  listAllEvents: vi.fn(), listExcluded: vi.fn(),
  setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { PortfolioTab } from '@/components/portfolio/PortfolioTab'
import { HISTORY_PAGE_SIZE, totalValue, unitPrice } from '@/components/portfolio/TransactionHistory'
import { averageCost } from '@/components/portfolio/TokenCard'

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()
const asset = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, name, symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', ...o,
})
const pos = (assetId: string, o: Record<string, unknown> = {}) => ({
  assetId, quantity: '0', knownRemainingBasis: '0', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], soldCount: 0, soldIncompleteCount: 0, price: null, value: null, unrealized: null, ...o,
})
const sum = (positions: unknown[], prices: Record<string, unknown> = {}, o: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices, asOf: new Date().toISOString(),
  summary: {
    positions, pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0',
    unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false, ...o,
  },
  ...root,
})
const emptyPerf = {
  currency: 'PKR', from: '2026-01-01T00:00:00Z', to: '2026-10-16T00:00:00Z', fxUnavailableAssets: [], points: [],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null, gain: null, gainUnavailableReason: 'x', returnPct: null, returnMethod: 'MODIFIED_DIETZ' },
}
const noImport = { dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 }

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset('MEC', 'Meta Earth'), asset('SDA', 'Sidra')])
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue(noImport)
  api.listEvents.mockResolvedValue([])
  api.summary.mockResolvedValue(sum([]))
})

describe('Portfolio Needs Attention', () => {
  const needy = () => sum(
    [pos('MEC', { quantity: '10', basisComplete: false, realizedComplete: false }), pos('SDA', { quantity: '5', unresolvedSales: [{ eventId: 'x', quantity: '2' }] })],
    {},
    { partial: true, unpricedAssets: ['MEC', 'SDA'], unknownBasisAssets: ['MEC', 'SDA'], unresolvedAssets: ['SDA'] },
  )

  it('lists what is missing with a direct action each, and says nothing is counted as zero', async () => {
    api.summary.mockResolvedValue(needy())
    render(<PortfolioPanel />)
    const panel = await screen.findByRole('region', { name: 'Portfolio Needs Attention' })
    expect(within(panel).getByText('2 tokens need a current price.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Add price: Meta Earth' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Add opening holdings: Sidra' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Review history: Meta Earth' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('never counted as zero')
  })

  it('Add price opens that token straight on the price form, without creating anything', async () => {
    api.summary.mockResolvedValue(needy())
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add price: Meta Earth' }))
    expect(await screen.findByLabelText(/Current price per unit/)).toBeInTheDocument()
    expect(api.setPrice).not.toHaveBeenCalled()
    expect(api.addEvent).not.toHaveBeenCalled()
  })

  it('Add opening holdings opens the opening-holding form', async () => {
    api.summary.mockResolvedValue(needy())
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Add opening holdings: Sidra' }))
    expect(await screen.findByLabelText('Type')).toHaveValue('OPENING')
  })

  it('flags a price older than a week and asks for an update', async () => {
    api.summary.mockResolvedValue(sum(
      [pos('MEC', { quantity: '10', price: '12', value: '120' })],
      { MEC: { price: '12', original: '12', quote: 'PKR', observedAt: iso(20) } },
    ))
    render(<PortfolioPanel />)
    const panel = await screen.findByRole('region', { name: 'Portfolio Needs Attention' })
    expect(within(panel).getByText('1 price may be out of date.')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Update price: Meta Earth' })).toBeInTheDocument()
  })

  it('counts RupChain trades left out and opens their review; unfinished ones only inform', async () => {
    api.summary.mockResolvedValue(sum([pos('MEC', { quantity: '1', price: '1', value: '1' })], { MEC: { price: '1', original: '1', quote: 'PKR', observedAt: iso(0) } }))
    api.importCtm.mockResolvedValue({ ...noImport, attention: [{ reason: 'disputed', count: 21 }, { reason: 'auto_completed', count: 5 }, { reason: 'in_progress', count: 2 }] })
    api.listExcluded.mockResolvedValue({ total: 0, items: [] })
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    const panel = await screen.findByRole('region', { name: 'Portfolio Needs Attention' })
    expect(within(panel).getByText('26 RupChain trades were left out of automatic tracking.')).toBeInTheDocument()
    expect(within(panel).getByText('2 RupChain trades are still in progress and will be added once confirmed.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: /in progress/ })).toBeNull()
  })

  it('archived tokens are not nagged about, and a complete portfolio shows no panel', async () => {
    api.listAssets.mockResolvedValue([asset('MEC', 'Meta Earth', { archivedAt: '2026-10-01T00:00:00Z' }), asset('SDA', 'Sidra')])
    api.summary.mockResolvedValue(sum(
      [pos('MEC', { quantity: '10' }), pos('SDA', { quantity: '5', price: '2', value: '10' })],
      { SDA: { price: '2', original: '2', quote: 'PKR', observedAt: iso(0) } },
      { partial: true, unpricedAssets: ['MEC'] },
    ))
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Sidra/ })
    expect(screen.queryByRole('region', { name: 'Portfolio Needs Attention' })).toBeNull()
  })
})

describe('token cards', () => {
  const priced = (observedAt: string, source?: string) => sum(
    [pos('MEC', { quantity: '60', knownRemainingBasis: '60600', price: '1200', value: '72000', unrealized: '11400' }), pos('SDA')],
    { MEC: { price: '1200', original: '1200', quote: 'PKR', observedAt, ...(source ? { source } : {}) } },
  )

  it('shows quantity, value, profit/loss, average cost and how current the price is', async () => {
    api.summary.mockResolvedValue(priced(iso(0), 'platform'))
    render(<PortfolioPanel />)
    const card = await screen.findByRole('button', { name: /^Meta Earth/ })
    expect(card).toHaveTextContent('60 held')
    expect(card).toHaveTextContent('PKR 72,000.00')
    expect(card).toHaveTextContent('P/L +11,400.00')
    expect(card).toHaveTextContent('Avg cost PKR 1,010')
    expect(card).toHaveTextContent('Price today, RupChain trade')
  })

  it('offers only the actions that fit: Add price when there is none, Record sell only when something is held', async () => {
    api.summary.mockResolvedValue(priced(iso(0)))
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    const mec = screen.getByRole('group', { name: 'Actions for Meta Earth' })
    expect(within(mec).queryByRole('button', { name: /price/i })).toBeNull() // fresh price: nothing to do
    expect(within(mec).getByRole('button', { name: 'Record sell' })).toBeInTheDocument()
    const sda = screen.getByRole('group', { name: 'Actions for Sidra' })
    expect(within(sda).getByRole('button', { name: 'Add price' })).toBeInTheDocument()
    expect(within(sda).queryByRole('button', { name: 'Record sell' })).toBeNull() // nothing held
  })

  it('a stale price gets an Update price action and a visible warning', async () => {
    api.summary.mockResolvedValue(priced(iso(15)))
    render(<PortfolioPanel />)
    expect(await screen.findByText('May be out of date')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Actions for Meta Earth' })).getByRole('button', { name: 'Update price' })).toBeInTheDocument()
  })

  it('quick actions open the token on the matching form', async () => {
    api.summary.mockResolvedValue(priced(iso(0)))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await user.click(within(screen.getByRole('group', { name: 'Actions for Meta Earth' })).getByRole('button', { name: 'Record sell' }))
    expect(await screen.findByLabelText('Type')).toHaveValue('SELL')
  })

  it('an unknown cost shows no average cost, and unknown profit is not printed as zero', async () => {
    api.summary.mockResolvedValue(sum(
      [pos('MEC', { quantity: '10', basisComplete: false, price: '12', value: '120' })],
      { MEC: { price: '12', original: '12', quote: 'PKR', observedAt: iso(0) } },
    ))
    render(<PortfolioPanel />)
    const card = await screen.findByRole('button', { name: /^Meta Earth/ })
    expect(card).toHaveTextContent('P/L not known yet')
    expect(card).not.toHaveTextContent('Avg cost')
    expect(averageCost({ quantity: '10', basisComplete: false, knownRemainingBasis: '0' } as never)).toBeNull()
    expect(averageCost({ quantity: '0', basisComplete: true, knownRemainingBasis: '0' } as never)).toBeNull()
  })

  it('shows average cost like other amounts: 2 decimals for money-sized, more only for tiny prices', () => {
    expect(averageCost({ quantity: '0.65', basisComplete: true, knownRemainingBasis: '27502000' } as never)).toBe('42,310,769.23')
    expect(averageCost({ quantity: '1000', basisComplete: true, knownRemainingBasis: '50000' } as never)).toBe('50.00')
    expect(averageCost({ quantity: '1000000', basisComplete: true, knownRemainingBasis: '12.34' } as never)).toBe('0.000012')
  })
})

describe('Price used: RupChain price or the price I got', () => {
  const withPlatform = () => sum(
    [pos('MEC', { quantity: '10', knownRemainingBasis: '100', price: '12', value: '120', unrealized: '20' })],
    { MEC: { price: '12', original: '12', quote: 'PKR', observedAt: iso(0), source: 'platform' } },
  )
  async function openBuy() {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await user.click(within(screen.getByRole('group', { name: 'Actions for Meta Earth' })).getByRole('button', { name: 'Record buy' }))
    await screen.findByLabelText('Type')
    return user
  }

  it('defaults to the RupChain price: the amount follows the quantity and is sent as a platform price', async () => {
    api.summary.mockResolvedValue(withPlatform())
    api.addEvent.mockResolvedValue({})
    const user = await openBuy()
    expect(screen.getByRole('radio', { name: /^RupChain price/ })).toBeChecked()
    expect(screen.queryByLabelText('Amount paid (PKR)')).toBeNull()
    expect(screen.getByTestId('platform-total')).toHaveTextContent('Enter a quantity')
    await user.type(screen.getByLabelText('Quantity'), '100')
    expect(screen.getByTestId('platform-total')).toHaveTextContent('1,200.00 PKR')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![1]).toMatchObject({ type: 'BUY', quantity: '100', consideration: '1200', priceBasis: 'platform' })
  })

  it('"Price I got" lets the user enter their own amount and shows the price per token it implies', async () => {
    api.summary.mockResolvedValue(withPlatform())
    api.addEvent.mockResolvedValue({})
    const user = await openBuy()
    await user.click(screen.getByRole('radio', { name: /^Price I got/ }))
    await user.type(screen.getByLabelText('Quantity'), '100')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '1300')
    expect(screen.getByText(/That is PKR 13 per token/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![1]).toMatchObject({ consideration: '1300', priceBasis: 'own' })
  })

  it('the RupChain price is only offered for an entry dated now, in the currency it is quoted in', async () => {
    api.summary.mockResolvedValue(withPlatform())
    const user = await openBuy()
    expect(screen.getByRole('radio', { name: /^RupChain price/ })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Currency of the amounts'), 'USDT')
    expect(screen.queryByRole('radio', { name: /^RupChain price/ })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Currency of the amounts'), 'PKR')
    expect(screen.getByRole('radio', { name: /^RupChain price/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-01-01T10:00' } })
    expect(screen.queryByRole('radio', { name: /^RupChain price/ })).toBeNull()
    expect(screen.getByLabelText('Amount paid (PKR)')).toBeInTheDocument()
  })

  it('when the portfolio is shown in USDT the RupChain price is offered in USDT too (converted at the current rate)', async () => {
    api.summary.mockResolvedValue(sum(
      [pos('MEC', { quantity: '10', knownRemainingBasis: '4', price: '0.04', value: '0.4', unrealized: '0.1' })],
      { MEC: { price: '0.04', original: '12', quote: 'PKR', observedAt: iso(0), source: 'platform' } },
      {}, { currency: 'USDT' },
    ))
    const user = await openBuy()
    expect(screen.getByLabelText('Currency of the amounts')).toHaveValue('USDT')
    expect(screen.getByRole('radio', { name: /USDT 0.04 per token/ })).toBeChecked()
    await user.type(screen.getByLabelText('Quantity'), '100')
    expect(screen.getByTestId('platform-total')).toHaveTextContent('4.00 USDT')
    await user.selectOptions(screen.getByLabelText('Currency of the amounts'), 'PKR')
    expect(screen.getByRole('radio', { name: /PKR 12 per token/ })).toBeInTheDocument()
    expect(screen.getByTestId('platform-total')).toHaveTextContent('1,200.00 PKR')
  })

  it('a token with no RupChain price (or a price the user typed) offers no choice and states no basis', async () => {
    api.summary.mockResolvedValue(sum(
      [pos('MEC', { quantity: '10', knownRemainingBasis: '100', price: '12', value: '120', unrealized: '20' })],
      { MEC: { price: '12', original: '12', quote: 'PKR', observedAt: iso(0) } },
    ))
    api.addEvent.mockResolvedValue({})
    const user = await openBuy()
    expect(screen.queryByRole('radio')).toBeNull()
    await user.type(screen.getByLabelText('Quantity'), '5')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '70')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![1]).not.toHaveProperty('priceBasis')
  })

  it('an opening holding never has a price basis', async () => {
    api.summary.mockResolvedValue(withPlatform())
    const user = await openBuy()
    await user.selectOptions(screen.getByLabelText('Type'), 'OPENING')
    expect(screen.queryByRole('radio')).toBeNull()
  })
})

describe('All transactions', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    id: 'e1', assetId: 'MEC', assetName: 'Meta Earth', assetSymbol: null, type: 'BUY', occurredAt: '2026-09-01T10:00:00.000Z', quantity: '100',
    consideration: '100000', fee: '1000', basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null,
    source: 'manual', voided: false, voidReason: null, priceBasis: null, ...o,
  })
  async function open() {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'All transactions' }))
    return user
  }
  beforeEach(() => {
    api.listAllEvents.mockResolvedValue({ total: 2, items: [row(), row({ id: 'e2', type: 'SELL', quantity: '40', consideration: '52000', fee: '0', source: 'ctm', priceBasis: 'platform' })] })
  })

  it('shows date, token, type, quantity, unit price, fee, total, source and status', async () => {
    await open()
    const table = await screen.findByRole('table')
    const cols = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(cols).toEqual(['Date', 'Token', 'Type', 'Quantity', 'Unit price', 'Fee', 'Total', 'Source', 'Status'])
    const buy = within(table).getAllByRole('row')[1]!
    expect(buy).toHaveTextContent('Buy')
    expect(buy).toHaveTextContent('1,000 PKR') // unit price
    expect(buy).toHaveTextContent('1,000.00 PKR') // fee
    expect(buy).toHaveTextContent('101,000.00 PKR') // total = amount + fee
    expect(buy).toHaveTextContent('Entered by me')
    expect(buy).toHaveTextContent('Counted')
    const sell = within(table).getAllByRole('row')[2]!
    expect(sell).toHaveTextContent('1,300 PKR')
    expect(sell).toHaveTextContent('RupChain trade')
    expect(sell).toHaveTextContent('RupChain price')
    expect(api.listAllEvents).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE, offset: 0 })
  })

  it('imported entries that are not counted say why; costs that are not recorded are not shown as zero', async () => {
    api.listAllEvents.mockResolvedValue({ total: 2, items: [
      row({ source: 'ctm', voided: true, voidReason: 'disputed' }),
      row({ id: 'e3', type: 'OPENING', consideration: null, fee: null, basis: null }),
    ] })
    await open()
    const table = await screen.findByRole('table')
    expect(within(table).getByText(/Not counted: in or after a dispute/)).toBeInTheDocument()
    expect(within(table).getByText('Cost not recorded')).toBeInTheDocument()
  })

  it('searching and filtering go to the server, return to the first page, and an empty result says so', async () => {
    const user = await open()
    await screen.findByRole('table')
    api.listAllEvents.mockResolvedValue({ total: 0, items: [] })
    await user.type(screen.getByLabelText('Search by token or note'), 'sid')
    await vi.waitFor(() => expect(api.listAllEvents).toHaveBeenLastCalledWith({ limit: HISTORY_PAGE_SIZE, offset: 0, q: 'sid' }))
    await user.selectOptions(screen.getByLabelText('Type'), 'SELL')
    await user.selectOptions(screen.getByLabelText('Source'), 'ctm')
    await user.selectOptions(screen.getByLabelText('Status'), 'not_counted')
    await vi.waitFor(() => expect(api.listAllEvents).toHaveBeenLastCalledWith({ limit: HISTORY_PAGE_SIZE, offset: 0, q: 'sid', type: 'SELL', source: 'ctm', status: 'not_counted' }))
    expect(await screen.findByText('Nothing matches these filters.')).toBeInTheDocument()
  })

  it('pages through a long history', async () => {
    api.listAllEvents.mockImplementation(async (q: { offset: number }) => ({ total: 60, items: [row({ id: `e${q.offset}` })] }))
    const user = await open()
    expect(await screen.findByText('Showing 1 to 25 of 60')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Showing 26 to 50 of 60')).toBeInTheDocument()
    expect(api.listAllEvents).toHaveBeenLastCalledWith({ limit: HISTORY_PAGE_SIZE, offset: HISTORY_PAGE_SIZE })
  })

  it('a token name opens that token', async () => {
    const user = await open()
    const table = await screen.findByRole('table')
    await user.click(within(table).getAllByRole('button', { name: 'Meta Earth' })[0]!)
    expect(await screen.findByRole('heading', { name: 'Meta Earth' })).toBeInTheDocument()
    expect(screen.queryByText('All transactions')).toBeNull()
  })

  it('is not offered where the tracker cannot list across tokens', () => {
    render(<PortfolioTab assets={[asset('MEC', 'Meta Earth') as never]} summary={sum([]) as never} />)
    expect(screen.queryByRole('button', { name: 'All transactions' })).toBeNull()
  })
})

describe('transaction maths (exact decimal, no floats)', () => {
  it('unit price is the recorded total over the quantity', () => {
    expect(unitPrice({ type: 'BUY', quantity: '3', consideration: '10' })).toBe('3.33333333')
    expect(unitPrice({ type: 'SELL', quantity: '40', consideration: '52000' })).toBe('1,300')
    expect(unitPrice({ type: 'OPENING', quantity: '5', consideration: null })).toBeNull()
    expect(unitPrice({ type: 'BUY', quantity: '0', consideration: '10' })).toBeNull()
  })
  it('total adds a buy fee and subtracts a sell fee; an opening shows its cost or nothing', () => {
    expect(totalValue({ type: 'BUY', consideration: '100', fee: '1.5', basis: null, zeroCost: false })).toBe('101.5')
    expect(totalValue({ type: 'SELL', consideration: '100', fee: '1.5', basis: null, zeroCost: false })).toBe('98.5')
    expect(totalValue({ type: 'OPENING', consideration: null, fee: null, basis: '500', zeroCost: false })).toBe('500')
    expect(totalValue({ type: 'OPENING', consideration: null, fee: null, basis: null, zeroCost: false })).toBeNull()
    expect(totalValue({ type: 'OPENING', consideration: null, fee: null, basis: '0', zeroCost: true })).toBe('0')
  })
})
