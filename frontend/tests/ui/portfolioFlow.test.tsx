import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDecimal, formatQuantity, formatSigned, isNegative } from '@/lib/portfolio/format'

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

describe('decimal-string formatting (no floats)', () => {
  it('groups thousands and rounds half-up', () => {
    expect(formatDecimal('1234567.891')).toBe('1,234,567.89')
    expect(formatDecimal('0.005')).toBe('0.01')
    expect(formatDecimal('999.999')).toBe('1,000.00')
    expect(formatDecimal('12', 0)).toBe('12')
    expect(formatDecimal('12.5', 0)).toBe('13')
  })
  it('stays exact beyond float precision', () => {
    expect(formatDecimal('9999999999999999999999999999.99')).toBe('9,999,999,999,999,999,999,999,999,999.99')
    expect(formatQuantity('0.000000000000000001')).toBe('0')
    expect(formatQuantity('0.00000001')).toBe('0.00000001')
  })
  it('never shows negative zero and always signs profit/loss', () => {
    expect(formatDecimal('-0.004')).toBe('0.00')
    expect(formatSigned('11200')).toBe('+11,200.00')
    expect(formatSigned('-2000')).toBe('-2,000.00')
    expect(formatSigned('0')).toBe('0.00')
    expect(isNegative('-5')).toBe(true)
    expect(isNegative('-0.00')).toBe(false)
  })
  it('trims quantity zeros and passes non-numbers through untouched', () => {
    expect(formatQuantity('60.00000000')).toBe('60')
    expect(formatQuantity('0.10000000')).toBe('0.1')
    expect(formatDecimal('abc')).toBe('abc')
  })
})

const asset = (id: string, name: string, over = {}) => ({
  id, name, symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', ...over,
})
const pos = (assetId: string, o: Record<string, unknown> = {}) => ({
  assetId, quantity: '0', knownRemainingBasis: '0', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], price: null, value: null, unrealized: null, ...o,
})
const sum = (o: Record<string, unknown> = {}, positions: unknown[] = [], prices = {}) => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices, asOf: '2026-10-16T10:00:00Z',
  summary: {
    positions, pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0',
    unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false, ...o,
  },
})

// Fictional spec fixtures (10.1 and 10.13), shaped as the server returns them.
const fixture = () => sum(
  { pricedValue: '207000', knownRemainingBasis: '193800', knownUnrealized: '13200', knownRealized: '11200', knownTotalPnl: '24400' },
  [
    pos('MEC', { quantity: '60', knownRemainingBasis: '60600', realizedKnown: '11200', price: '1200', value: '72000', unrealized: '11400' }),
    pos('SDA', { quantity: '1000', knownRemainingBasis: '10000', price: '8', value: '8000', unrealized: '-2000' }),
  ],
  { MEC: { price: '1200', original: '1200', quote: 'PKR', observedAt: '2026-10-16T09:00:00Z' } },
)
const ev = (o: Record<string, unknown> = {}) => ({
  id: 'e1', assetId: 'MEC', type: 'BUY', occurredAt: '2026-01-01T10:00:00Z', quantity: '100', consideration: '100000', fee: '1000',
  basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null, ...o,
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset('MEC', 'Meta Earth'), asset('SDA', 'Sidra')])
  api.summary.mockResolvedValue(fixture())
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})

describe('overview numbers', () => {
  it('shows the spec aggregate and no partial warning when everything is known', async () => {
    render(<PortfolioPanel />)
    expect(await screen.findByText('PKR 207,000.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +24,400.00')).toBeInTheDocument() // total profit / loss
    expect(screen.getByText('PKR +11,200.00')).toBeInTheDocument() // profit from sales (Breakdown)
    expect(screen.getByText('PKR +13,200.00')).toBeInTheDocument() // holding profit / loss (Breakdown)
    expect(screen.queryByText(/Partial/)).toBeNull()
    expect(screen.queryByText(/missing information/)).toBeNull()
    expect(screen.getByLabelText(/not verified ownership/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Method: FIFO/)).toBeInTheDocument()
  })
  it('flags partial data by token name and says nothing was counted as zero', async () => {
    api.summary.mockResolvedValue(sum(
      { partial: true, unpricedAssets: ['SDA'], unknownBasisAssets: ['MEC'], unresolvedAssets: ['SDA'] },
      [pos('MEC'), pos('SDA')],
    ))
    render(<PortfolioPanel />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(screen.getByRole('button', { name: 'Add price: Sidra' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add previous holdings: Sidra' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View transactions: Meta Earth' })).toBeInTheDocument()
    expect(screen.getByText('Cost of some units is not recorded')).toBeInTheDocument()
  })
  it('rows show quantity, value or "No price", and signed profit/loss', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { quantity: '60', value: '72000', unrealized: '11400' }), pos('SDA', { quantity: '5' })]))
    render(<PortfolioPanel />)
    const mec = await screen.findByRole('button', { name: /^Meta Earth/ })
    expect(mec).toHaveTextContent('60 held')
    expect(mec).toHaveTextContent('PKR 72,000.00')
    expect(mec).toHaveTextContent('+11,400.00')
    expect(screen.getByRole('button', { name: /^Sidra/ })).toHaveTextContent('No price')
  })
  it('a token with no records yet shows no position numbers (and no invented zero)', async () => {
    api.summary.mockResolvedValue(sum())
    render(<PortfolioPanel />)
    const row = await screen.findByRole('button', { name: /^Meta Earth/ })
    expect(row).not.toHaveTextContent('held')
    expect(screen.queryByText(/missing information/)).toBeNull()
  })
})

describe('token detail', () => {
  async function openMec() {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    return user
  }
  // Previous holdings live in the token's discreet menu, not among the main buttons.
  async function openPrevious(user: ReturnType<typeof userEvent.setup>) {
    expect(screen.queryByRole('button', { name: /Add previous holdings|Add opening holding/ })).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Add previous holdings' }))
  }

  it('shows the position from the engine, with labels instead of colour alone', async () => {
    await openMec()
    expect(await screen.findByText('Quantity')).toBeInTheDocument()
    expect(screen.getByText('60')).toBeInTheDocument()
    expect(screen.getByText('60,600.00')).toBeInTheDocument()
    expect(screen.getByText('72,000.00')).toBeInTheDocument()
    expect(screen.getByText('+11,400.00')).toBeInTheDocument()
    expect(screen.getAllByText('PKR +11,200.00').length).toBeGreaterThan(0)
  })
  it('unknown cost and missing price read as Not known yet / Unavailable, never zero', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { quantity: '10', basisComplete: false, realizedComplete: false })]))
    await openMec()
    expect((await screen.findAllByText('Not known yet', { selector: 'dd' })).length).toBe(3) // average cost, remaining cost, profit from sales
    expect(screen.getByText('Not known')).toBeInTheDocument() // profit / loss tile
    expect(screen.getAllByText('No price').length).toBe(2) // value tile and current price
  })
  it('explains an oversold history instead of showing imaginary profit', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { unresolvedSales: [{ eventId: 'x', quantity: '5' }] })]))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Needs review/ }))
    expect(await screen.findByText(/no profit is counted for the excess/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add previous holdings' })).toBeInTheDocument()
  })
  it('renders history in a semantic table and shows hostile notes as plain text', async () => {
    api.listEvents.mockResolvedValue([ev({ note: '<img src=x onerror=alert(1)>' }), ev({ id: 'e2', type: 'OPENING', consideration: null, fee: null, basis: null })])
    const { container } = render(<PortfolioPanel />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(expect.arrayContaining(['Date', 'Type', 'Quantity']))
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(within(table).getByText('Cost not recorded')).toBeInTheDocument()
    expect(within(table).getAllByText(/manual/).length).toBe(2)
  })

  it('records a buy with exact decimal strings, then refreshes totals and history', async () => {
    api.addEvent.mockResolvedValue(ev())
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record Transaction' }))
    expect(screen.getByRole('radio', { name: 'Buy' })).toHaveAttribute('aria-checked', 'true')
    await user.type(screen.getByLabelText('Quantity'), '100')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '100000')
    await user.click(screen.getByRole('button', { name: /More options/ }))
    await user.type(screen.getByLabelText(/Fee/), '1000')
    const summaryCalls = api.summary.mock.calls.length
    const listCalls = api.listEvents.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const [assetId, input] = api.addEvent.mock.calls[0]!
    expect(assetId).toBe('MEC')
    expect(input).toMatchObject({ type: 'BUY', quantity: '100', consideration: '100000', fee: '1000' })
    expect(input.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
    expect(input.clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(typeof input.quantity).toBe('string')
    await vi.waitFor(() => expect(api.summary.mock.calls.length).toBe(summaryCalls + 1))
    expect(api.listEvents.mock.calls.length).toBe(listCalls + 1)
    await vi.waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(screen.getByRole('button', { name: 'Record Transaction' })).toBeInTheDocument()
  })
  it('a sell is labelled "Amount received" and a failed save can be retried with the same request id', async () => {
    api.addEvent.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(ev({ type: 'SELL' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record Transaction' }))
    await user.click(screen.getByRole('radio', { name: 'Sell' }))
    await user.type(screen.getByLabelText('Quantity'), '40')
    await user.type(screen.getByLabelText('Amount received (PKR)'), '52000')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Network down')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('40')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(2))
    expect(api.addEvent.mock.calls[1]![1].clientRequestId).toBe(api.addEvent.mock.calls[0]![1].clientRequestId)
  })
  it.each([
    ['text quantity', 'Quantity', 'abc'], ['zero quantity', 'Quantity', '0'], ['exponent', 'Quantity', '1e3'],
    ['comma decimal', 'Quantity', '1,5'], ['negative', 'Quantity', '-2'],
  ])('rejects %s without calling the API', async (_l, label, bad) => {
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record Transaction' }))
    await user.type(screen.getByLabelText(label), bad)
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.addEvent).not.toHaveBeenCalled()
    expect(await screen.findByText(/Enter a quantity greater than zero/)).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveFocus()
  })
  it('requires an amount for a buy and rejects a future date', async () => {
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record Transaction' }))
    expect(screen.queryByLabelText('Date and time')).toBeNull() // defaults to now, no big date field
    await user.type(screen.getByLabelText('Quantity'), '1')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Enter the amount as a plain number/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '10')
    await user.click(screen.getByRole('button', { name: 'Different date' }))
    const when = screen.getByLabelText('Date and time')
    await user.clear(when)
    await user.type(when, '2999-01-01T10:00')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Date cannot be in the future.')).toBeInTheDocument()
    expect(api.addEvent).not.toHaveBeenCalled()
  })
  it('opening holding: blank cost stays unknown, and zero cost must be confirmed explicitly', async () => {
    api.addEvent.mockResolvedValue(ev({ type: 'OPENING' }))
    const user = await openMec()
    await openPrevious(user)
    expect(screen.getByText(/never counted as zero/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Quantity'), '10')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    const unknown = api.addEvent.mock.calls[0]![1]
    expect(unknown).toMatchObject({ type: 'OPENING', quantity: '10' })
    expect(unknown).not.toHaveProperty('basis')
    expect(unknown).not.toHaveProperty('zeroCost')

    await openPrevious(user)
    await user.type(screen.getByLabelText('Quantity'), '3')
    await user.click(screen.getByLabelText(/cost me nothing/))
    expect(screen.getByLabelText(/Total cost/)).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(2))
    expect(api.addEvent.mock.calls[1]![1]).toMatchObject({ basis: '0', zeroCost: true })
  })
  it('removes an entry only after a second confirmation, then refreshes', async () => {
    api.listEvents.mockResolvedValueOnce([ev()]).mockResolvedValue([])
    api.deleteEvent.mockResolvedValue(undefined)
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Remove Buy entry/ }))
    expect(api.deleteEvent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(api.deleteEvent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Remove Buy entry/ }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))
    await vi.waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith('MEC', 'e1'))
    expect(await screen.findByText('No entries yet.')).toBeInTheDocument()
  })
  it('manual price: valid value is sent as a string, zero is rejected', async () => {
    api.setPrice.mockResolvedValue({ price: '1200', observedAt: '2026-10-16T10:00:00Z' })
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Update price' }))
    expect(screen.getByLabelText(/not a market quote and is not a transaction/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Price per unit/), '0')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument()
    expect(api.setPrice).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText(/Price per unit/))
    await user.type(screen.getByLabelText(/Price per unit/), '1200')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    await vi.waitFor(() => expect(api.setPrice).toHaveBeenCalledWith('MEC', '1200', 'PKR', 'manual'))
  })
})

describe('price source and age', () => {
  const ageIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
  const priced = (observedAt: string, source?: string) => sum(
    {}, [pos('MEC', { quantity: '60', price: '1200', value: '72000' })],
    { MEC: { price: '1200', original: '1200', quote: 'PKR', observedAt, ...(source ? { source } : {}) } },
  )
  async function openMec() {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    return user
  }

  it('says where a price came from: a platform trade price versus one you typed', async () => {
    api.summary.mockResolvedValue(priced(ageIso(0), 'platform'))
    await openMec()
    expect(await screen.findByText(/Latest RupChain trade/)).toBeInTheDocument()
  })
  it('flags a price older than a week as possibly out of date, and a fresh one is not flagged', async () => {
    api.summary.mockResolvedValue(priced(ageIso(12)))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Needs review/ }))
    expect(await screen.findByText(/recorded 12 days ago and may be out of date/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Update price' }).length).toBe(2) // the fix in the review list and the page button
  })
  it('a fresh price only states its age', async () => {
    api.summary.mockResolvedValue(priced(ageIso(0)))
    await openMec()
    expect(await screen.findByText('Quantity')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Needs review/ })).toBeNull()
    expect(screen.queryByText(/may be out of date/)).toBeNull()
  })
  it('the price form sends the chosen source', async () => {
    api.setPrice.mockResolvedValue({ price: '13', quote: 'PKR', observedAt: '2026-10-16T10:00:00Z' })
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Update price' }))
    await user.type(screen.getByLabelText(/Price per unit/), '13')
    await user.selectOptions(screen.getByLabelText(/Source, optional/), 'p2p')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    await vi.waitFor(() => expect(api.setPrice).toHaveBeenCalledWith('MEC', '13', 'PKR', 'p2p'))
  })
})

describe('metadata edits do not trigger any financial change', () => {
  it('editing details calls only the metadata endpoint, never recording, pricing or recalculation', async () => {
    api.updateAsset.mockResolvedValue(asset('MEC', 'Renamed'))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    const summaryCalls = api.summary.mock.calls.length
    await user.click(await screen.findByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit details' }))
    const name = screen.getByLabelText('Token name')
    await user.clear(name)
    await user.type(name, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    await vi.waitFor(() => expect(api.updateAsset).toHaveBeenCalledTimes(1))
    expect(api.addEvent).not.toHaveBeenCalled()
    expect(api.deleteEvent).not.toHaveBeenCalled()
    expect(api.setPrice).not.toHaveBeenCalled()
    expect(api.summary.mock.calls.length).toBe(summaryCalls) // numbers untouched, nothing recomputed
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument()
    expect(screen.getByText('60,600.00')).toBeInTheDocument() // same figures after the rename
  })
})

describe('PKR / USDT switch', () => {
  const usdtSummary = (o: Record<string, unknown> = {}) => ({
    ...sum({ pricedValue: '450', knownRealized: '10', knownUnrealized: '5', knownTotalPnl: '15' }, [pos('MEC', { quantity: '60', value: '450', unrealized: '5' })],
      { MEC: { price: '7.5', original: '2100', quote: 'PKR', observedAt: '2026-10-16T09:00:00Z' } }),
    currency: 'USDT', fx: { usdtPkr: '280' }, ...o,
  })

  it('switching currency re-requests the summary in that currency and relabels every figure', async () => {
    api.summary.mockImplementation(async (c: string) => (c === 'USDT' ? usdtSummary() : fixture()))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    expect(await screen.findByText('PKR 207,000.00')).toBeInTheDocument()
    expect(api.summary).toHaveBeenLastCalledWith('PKR')
    await user.click(screen.getByRole('radio', { name: 'USDT' }))
    expect((await screen.findAllByText('USDT 450.00')).length).toBeGreaterThan(0)
    expect(api.summary).toHaveBeenLastCalledWith('USDT')
    expect(screen.getByRole('radio', { name: 'USDT' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'PKR' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText(/280.00 PKR per USDT/)).toBeInTheDocument()
  })
  it('labels keep matching the numbers on screen while a currency switch is still loading', async () => {
    let release: (v: unknown) => void = () => {}
    api.summary.mockImplementation((c: string) => (c === 'USDT' ? new Promise((r) => { release = r }) : Promise.resolve(fixture())))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    expect(await screen.findByText('PKR 207,000.00')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'USDT' }))
    expect(screen.getByRole('radio', { name: 'USDT' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('PKR 207,000.00')).toBeInTheDocument() // still PKR numbers, still PKR label
    release(usdtSummary())
    expect((await screen.findAllByText('USDT 450.00')).length).toBeGreaterThan(0)
    expect(screen.queryByText('PKR 207,000.00')).toBeNull()
  })
  it('lists tokens that have no rate for the chosen currency and never shows them as zero', async () => {
    api.summary.mockResolvedValue(usdtSummary({ fxUnavailableAssets: ['SDA'], summary: { ...usdtSummary().summary, partial: true } }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(screen.getByText('Cost of some entries is unknown in USDT')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View transactions: Sidra' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '← Back to portfolio' }))
    expect(screen.getByRole('button', { name: /^Sidra/ })).toHaveTextContent('No entries yet')
    await user.click(screen.getByRole('button', { name: /^Sidra/ }))
    expect(await screen.findByText(/No entries yet. Record a transaction/)).toBeInTheDocument()
  })
  it('shows a price entered in another currency together with its original value', async () => {
    api.summary.mockResolvedValue(usdtSummary())
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    expect(await screen.findByText('7.5')).toBeInTheDocument()
    expect(screen.getByText(/as 2,100 PKR/)).toBeInTheDocument()
  })
  it('a price whose conversion is impossible says so instead of showing zero', async () => {
    api.summary.mockResolvedValue(usdtSummary({
      fx: { usdtPkr: null },
      prices: { MEC: { price: null, original: '2100', quote: 'PKR', observedAt: '2026-10-16T09:00:00Z' } },
    }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    expect((await screen.findAllByText('No price')).length).toBeGreaterThan(0)
    expect(screen.getByText(/no USDT\/PKR rate is available to convert it/)).toBeInTheDocument()
  })

  async function openRecord(name: string) {
    api.summary.mockImplementation(async (c: string) => (c === 'USDT' ? usdtSummary() : fixture()))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByText('PKR 207,000.00')
    await user.click(screen.getByRole('radio', { name: 'USDT' }))
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    await user.click(await screen.findByRole('button', { name }))
    return user
  }
  it('the entry form starts in the currency being viewed and sends the currency without a typed rate', async () => {
    api.addEvent.mockResolvedValue(ev())
    const user = await openRecord('Record Transaction')
    expect(screen.getByRole('radio', { name: 'USDT' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Amount paid (USDT)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/USDT\/PKR rate for this date/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Quantity'), '10')
    await user.type(screen.getByLabelText('Amount paid (USDT)'), '36')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![1]).toMatchObject({ quote: 'USDT', consideration: '36' })
    expect(api.addEvent.mock.calls[0]![1]).not.toHaveProperty('fxRate')
  })
  it('the price form can enter a price in USDT', async () => {
    api.setPrice.mockResolvedValue({ price: '2', quote: 'USDT', observedAt: '2026-10-16T10:00:00Z' })
    const user = await openRecord('Update price')
    expect(screen.getByRole('radio', { name: 'USDT' })).toHaveAttribute('aria-checked', 'true')
    await user.type(screen.getByLabelText(/Price per unit \(USDT\)/), '2')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    await vi.waitFor(() => expect(api.setPrice).toHaveBeenCalledWith('MEC', '2', 'USDT', 'manual'))
  })
  it('history shows each entry in its own currency with the rate recorded for it', async () => {
    api.listEvents.mockResolvedValue([
      ev({ id: 'a', quote: 'USDT', consideration: '36', fee: '0', fxRate: '278.5', fxSource: 'manual' }),
      ev({ id: 'b', consideration: '10000', fee: '0', fxRate: '280', fxSource: 'platform' }),
    ])
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText(/36.00 USDT/)).toBeInTheDocument()
    expect(within(table).getByText(/10,000.00 PKR/)).toBeInTheDocument()
    expect(within(table).getByText(/278.50 PKR\/USDT \(entered by you\)/)).toBeInTheDocument()
    expect(within(table).getByText(/280.00 PKR\/USDT$/)).toBeInTheDocument()
  })
})