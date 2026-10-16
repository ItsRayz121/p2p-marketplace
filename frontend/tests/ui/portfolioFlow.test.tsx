import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDecimal, formatQuantity, formatSigned, isNegative } from '@/lib/portfolio/format'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { RECORD_ONLY_NOTICE } from '@/components/portfolio/EventForm'

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
  currency: 'PKR', method: 'FIFO', prices, asOf: '2026-10-16T10:00:00Z',
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
  { MEC: { price: '1200', observedAt: '2026-10-16T09:00:00Z' } },
)
const ev = (o: Record<string, unknown> = {}) => ({
  id: 'e1', assetId: 'MEC', type: 'BUY', occurredAt: '2026-01-01T10:00:00Z', quantity: '100', consideration: '100000', fee: '1000',
  basis: null, zeroCost: false, note: null, ...o,
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset('MEC', 'Meta Earth'), asset('SDA', 'Sidra')])
  api.summary.mockResolvedValue(fixture())
  api.listEvents.mockResolvedValue([])
})

describe('overview numbers', () => {
  it('shows the spec aggregate and no partial warning when everything is known', async () => {
    render(<PortfolioPanel />)
    expect(await screen.findByText('PKR 207,000.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +11,200.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +13,200.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +24,400.00')).toBeInTheDocument()
    expect(screen.queryByText(/Partial data/)).toBeNull()
    expect(screen.getByText(/not verified ownership/i)).toBeInTheDocument()
    expect(screen.getByText(/Method: FIFO/)).toBeInTheDocument()
  })
  it('flags partial data by token name and says nothing was counted as zero', async () => {
    api.summary.mockResolvedValue(sum(
      { partial: true, unpricedAssets: ['SDA'], unknownBasisAssets: ['MEC'], unresolvedAssets: ['SDA'] },
      [pos('MEC'), pos('SDA')],
    ))
    render(<PortfolioPanel />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Partial data')
    expect(alert).toHaveTextContent('not counted as zero')
    expect(within(alert).getByText(/No current price: Sidra/)).toBeInTheDocument()
    expect(within(alert).getByText(/Unknown cost: Meta Earth/)).toBeInTheDocument()
    expect(within(alert).getByText(/Sold more than recorded.*Sidra/)).toBeInTheDocument()
  })
  it('rows show quantity, value or "No price", and signed profit/loss', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { quantity: '60', value: '72000', unrealized: '11400' }), pos('SDA', { quantity: '5' })]))
    render(<PortfolioPanel />)
    const mec = await screen.findByRole('button', { name: /Meta Earth/ })
    expect(mec).toHaveTextContent('60 held')
    expect(mec).toHaveTextContent('PKR 72,000.00')
    expect(mec).toHaveTextContent('P/L +11,400.00')
    expect(screen.getByRole('button', { name: /Sidra/ })).toHaveTextContent('No price')
  })
  it('a token with no records yet shows no position numbers (and no invented zero)', async () => {
    api.summary.mockResolvedValue(sum())
    render(<PortfolioPanel />)
    const row = await screen.findByRole('button', { name: /Meta Earth/ })
    expect(row).not.toHaveTextContent('held')
    expect(screen.queryByText('Partial data')).toBeNull()
  })
})

describe('token detail', () => {
  async function openMec() {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /Meta Earth/ }))
    return user
  }

  it('shows the position from the engine, with labels instead of colour alone', async () => {
    await openMec()
    expect(await screen.findByText('Recorded quantity')).toBeInTheDocument()
    expect(screen.getByText('60')).toBeInTheDocument()
    expect(screen.getByText('60,600.00')).toBeInTheDocument()
    expect(screen.getByText('72,000.00')).toBeInTheDocument()
    expect(screen.getByText('PKR +11,400.00')).toBeInTheDocument()
    expect(screen.getAllByText('PKR +11,200.00').length).toBeGreaterThan(0)
    expect(screen.getByText(/Based on your recorded history/)).toBeInTheDocument()
  })
  it('unknown cost and missing price read as Unknown / Unavailable, never zero', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { quantity: '10', basisComplete: false, realizedComplete: false })]))
    await openMec()
    expect(await screen.findByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('No price')).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBe(2)
  })
  it('explains an oversold history instead of showing imaginary profit', async () => {
    api.summary.mockResolvedValue(sum({}, [pos('MEC', { unresolvedSales: [{ eventId: 'x', quantity: '5' }] })]))
    await openMec()
    expect(await screen.findByText(/No profit is counted for the excess/)).toBeInTheDocument()
  })
  it('renders history in a semantic table and shows hostile notes as plain text', async () => {
    api.listEvents.mockResolvedValue([ev({ note: '<img src=x onerror=alert(1)>' }), ev({ id: 'e2', type: 'OPENING', consideration: null, fee: null, basis: null })])
    const { container } = render(<PortfolioPanel />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Meta Earth/ }))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(expect.arrayContaining(['Date', 'Type', 'Quantity']))
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(within(table).getByText('Unknown cost')).toBeInTheDocument()
    expect(within(table).getAllByText(/manual/).length).toBe(2)
  })

  it('records a buy with exact decimal strings, then refreshes totals and history', async () => {
    api.addEvent.mockResolvedValue(ev())
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record buy' }))
    expect(screen.getByText(RECORD_ONLY_NOTICE)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Quantity'), '100')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '100000')
    await user.type(screen.getByLabelText(/Fee/), '1000')
    const summaryCalls = api.summary.mock.calls.length
    const listCalls = api.listEvents.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    const [assetId, input] = api.addEvent.mock.calls[0]!
    expect(assetId).toBe('MEC')
    expect(input).toMatchObject({ type: 'BUY', quantity: '100', consideration: '100000', fee: '1000' })
    expect(input.occurredAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
    expect(input.clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(typeof input.quantity).toBe('string')
    await vi.waitFor(() => expect(api.summary.mock.calls.length).toBe(summaryCalls + 1))
    expect(api.listEvents.mock.calls.length).toBe(listCalls + 1)
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.getByRole('button', { name: 'Record buy' })).toHaveFocus()
  })
  it('a sell is labelled "Amount received" and a failed save can be retried with the same request id', async () => {
    api.addEvent.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(ev({ type: 'SELL' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record sell' }))
    await user.type(screen.getByLabelText('Quantity'), '40')
    await user.type(screen.getByLabelText('Amount received (PKR)'), '52000')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(await screen.findByText('Network down')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('40')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(2))
    expect(api.addEvent.mock.calls[1]![1].clientRequestId).toBe(api.addEvent.mock.calls[0]![1].clientRequestId)
  })
  it.each([
    ['text quantity', 'Quantity', 'abc'], ['zero quantity', 'Quantity', '0'], ['exponent', 'Quantity', '1e3'],
    ['comma decimal', 'Quantity', '1,5'], ['negative', 'Quantity', '-2'],
  ])('rejects %s without calling the API', async (_l, label, bad) => {
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record buy' }))
    await user.type(screen.getByLabelText(label), bad)
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '10')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(api.addEvent).not.toHaveBeenCalled()
    expect(await screen.findByText(/Enter a quantity greater than zero/)).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveFocus()
  })
  it('requires an amount for a buy and rejects a future date', async () => {
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Record buy' }))
    await user.type(screen.getByLabelText('Quantity'), '1')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(await screen.findByText(/Enter the amount as a plain number/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '10')
    const when = screen.getByLabelText('Date and time')
    await user.clear(when)
    await user.type(when, '2999-01-01T10:00')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    expect(await screen.findByText('Date cannot be in the future.')).toBeInTheDocument()
    expect(api.addEvent).not.toHaveBeenCalled()
  })
  it('opening holding: blank cost stays unknown, and zero cost must be confirmed explicitly', async () => {
    api.addEvent.mockResolvedValue(ev({ type: 'OPENING' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: 'Add opening holding' }))
    expect(screen.getByText(/never treated as zero/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Quantity'), '10')
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    const unknown = api.addEvent.mock.calls[0]![1]
    expect(unknown).toMatchObject({ type: 'OPENING', quantity: '10' })
    expect(unknown).not.toHaveProperty('basis')
    expect(unknown).not.toHaveProperty('zeroCost')

    await user.click(await screen.findByRole('button', { name: 'Add opening holding' }))
    await user.type(screen.getByLabelText('Quantity'), '3')
    await user.click(screen.getByLabelText(/cost me nothing/))
    expect(screen.getByLabelText(/Total cost/)).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save entry' }))
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
    await user.click(await screen.findByRole('button', { name: 'Update current price' }))
    expect(screen.getByText(/not a market quote and is not a transaction/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Current price per unit/), '0')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument()
    expect(api.setPrice).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText(/Current price per unit/))
    await user.type(screen.getByLabelText(/Current price per unit/), '1200')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    await vi.waitFor(() => expect(api.setPrice).toHaveBeenCalledWith('MEC', '1200'))
  })
})

describe('metadata edits do not trigger any financial change', () => {
  it('editing details calls only the metadata endpoint, never recording, pricing or recalculation', async () => {
    api.updateAsset.mockResolvedValue(asset('MEC', 'Renamed'))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /Meta Earth/ }))
    const summaryCalls = api.summary.mock.calls.length
    await user.click(await screen.findByRole('button', { name: 'Edit details' }))
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
