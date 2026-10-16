import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { newlyOversold } from '@/lib/portfolio/oversold'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), updateEvent: vi.fn(), eventHistory: vi.fn(),
  setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const ev = (o: Record<string, unknown> = {}) => ({
  id: 'e1', assetId: 'MEC', type: 'BUY', occurredAt: '2026-01-01T10:00:30.000Z', quantity: '100', consideration: '100000', fee: '1000',
  basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: 'first', source: 'manual', voided: false, voidReason: null, editedAt: null, ...o,
})
const summary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
}
const emptyPerf = {
  currency: 'PKR', from: '2026-01-01T00:00:00Z', to: '2026-10-16T00:00:00Z', fxUnavailableAssets: [], points: [],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: null, gain: null, gainUnavailableReason: 'x', returnPct: null, returnMethod: 'MODIFIED_DIETZ' },
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([{ id: 'MEC', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z' }])
  api.summary.mockResolvedValue(summary)
  api.performance.mockResolvedValue(emptyPerf)
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
  api.listEvents.mockResolvedValue([ev()])
})

async function openMec() {
  const user = userEvent.setup()
  render(<PortfolioPanel />)
  await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
  return user
}

describe('correcting an entry', () => {
  it('opens the form filled in, sends the corrected values without a request id, then refreshes', async () => {
    api.updateEvent.mockResolvedValue(ev({ quantity: '120', editedAt: '2026-10-16T10:00:00Z' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    expect(screen.getByText(/earlier version of this entry is kept in its history/)).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('100')
    expect(screen.getByLabelText('Amount paid (PKR)')).toHaveValue('100000')
    expect(screen.getByLabelText(/Fee/)).toHaveValue('1000')
    expect(screen.getByLabelText(/Note/)).toHaveValue('first')
    const summaryCalls = api.summary.mock.calls.length
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '120')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1))
    const [assetId, eventId, input] = api.updateEvent.mock.calls[0]!
    expect([assetId, eventId]).toEqual(['MEC', 'e1'])
    expect(input).toMatchObject({ type: 'BUY', quantity: '120', consideration: '100000', fee: '1000', note: 'first' })
    expect(input).not.toHaveProperty('clientRequestId')
    expect(api.addEvent).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(api.summary.mock.calls.length).toBe(summaryCalls + 1))
  })

  it('an untouched date keeps its exact original time (the picker only has minutes)', async () => {
    api.updateEvent.mockResolvedValue(ev())
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalled())
    expect(api.updateEvent.mock.calls[0]![2].occurredAt).toBe('2026-01-01T10:00:30.000Z')
  })

  it('invalid corrections never reach the API', async () => {
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '0')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument()
    expect(api.updateEvent).not.toHaveBeenCalled()
  })

  it('a failed save keeps the form and the typed values', async () => {
    api.updateEvent.mockRejectedValue(new Error('This entry was changed somewhere else. Reload it and try again.'))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '120')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue('120')
  })

  it('imported RupChain trades have no Edit button', async () => {
    api.listEvents.mockResolvedValue([ev({ source: 'ctm' })])
    await openMec()
    expect(await screen.findByText('Read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit (Buy|Sell|Opening)/ })).toBeNull()
  })
})

describe('warning before an edit or removal leaves a sale without units behind it', () => {
  const sell = ev({ id: 'e2', type: 'SELL', occurredAt: '2026-02-01T10:00:00.000Z', quantity: '80', consideration: '90000', fee: '0' })

  it('removing the buy that a sale depends on says so, and still lets the user confirm', async () => {
    api.listEvents.mockResolvedValue([ev(), sell])
    api.deleteEvent.mockResolvedValue(undefined)
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Remove Buy entry/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('Removing this leaves 80 units sold beyond what your history shows')
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))
    await vi.waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith('MEC', 'e1'))
  })

  it('removing an entry that nothing depends on shows no warning', async () => {
    api.listEvents.mockResolvedValue([ev(), sell])
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Remove Sell entry/ }))
    expect(screen.queryByText(/sold beyond/)).toBeNull()
  })

  it('shrinking the buy below the sale warns once; Save anyway then saves', async () => {
    api.listEvents.mockResolvedValue([ev(), sell])
    api.updateEvent.mockResolvedValue(ev({ quantity: '50' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '50')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/30 units would be sold beyond what your history shows/)).toBeInTheDocument()
    expect(api.updateEvent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save anyway' }))
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1))
  })
})

describe('the warning always matches what is about to be saved', () => {
  const sell = ev({ id: 'e2', type: 'SELL', occurredAt: '2026-02-01T10:00:00.000Z', quantity: '80', consideration: '90000', fee: '0' })

  it('if the values change after a warning, the new warning is shown before anything is saved', async () => {
    api.listEvents.mockResolvedValue([ev(), sell])
    api.updateEvent.mockResolvedValue(ev({ quantity: '40' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '50')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/30 units would be sold beyond/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '40')
    await user.click(screen.getByRole('button', { name: 'Save anyway' }))
    expect(await screen.findByText(/40 units would be sold beyond/)).toBeInTheDocument()
    expect(api.updateEvent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save anyway' }))
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1))
  })

  it('if the problem is fixed after a warning, saving goes straight through', async () => {
    api.listEvents.mockResolvedValue([ev(), sell])
    api.updateEvent.mockResolvedValue(ev({ quantity: '90' }))
    const user = await openMec()
    await user.click(await screen.findByRole('button', { name: /Edit Buy entry/ }))
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '50')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(/30 units would be sold beyond/)
    await user.clear(screen.getByLabelText('Quantity'))
    await user.type(screen.getByLabelText('Quantity'), '90')
    await user.click(screen.getByRole('button', { name: 'Save anyway' }))
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1))
    expect(api.updateEvent.mock.calls[0]![2].quantity).toBe('90')
  })
})

describe('history of a corrected entry', () => {
  it('lists earlier versions on request', async () => {
    api.listEvents.mockResolvedValue([ev({ editedAt: '2026-10-16T09:00:00Z', quantity: '120' })])
    api.eventHistory.mockResolvedValue([
      { id: 'r1', action: 'edit', before: { type: 'BUY', quantity: '100', consideration: '100000', quote: 'PKR', fee: '1000', occurredAt: '2026-01-01T10:00:30.000Z' }, changedAt: '2026-10-16T09:00:00Z' },
    ])
    const user = await openMec()
    expect(await screen.findByText(/manual, edited/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History' }))
    const hist = await screen.findByText('Earlier versions of this entry')
    const cell = hist.closest('td')!
    expect(within(cell).getByText(/Buy 100 · 100,000.00 PKR · fee 1,000.00/)).toBeInTheDocument()
    expect(api.eventHistory).toHaveBeenCalledWith('MEC', 'e1')
  })

  it('an entry that was never corrected has no History button', async () => {
    await openMec()
    await screen.findByText('Remove')
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
  })
})

describe('newlyOversold', () => {
  const E = (id: string, type: 'BUY' | 'SELL' | 'OPENING', at: string, quantity: string) =>
    ({ id, type, occurredAt: at, quantity, voided: false }) as never
  const list = [E('b', 'BUY', '2026-01-01T00:00:00Z', '100'), E('s', 'SELL', '2026-02-01T00:00:00Z', '80')]
  it('is zero when nothing new goes wrong', () => {
    expect(newlyOversold(list, { replace: { id: 'b', type: 'BUY', occurredAt: '2026-01-01T00:00:00Z', quantity: '90' } })).toBe('0')
  })
  it('counts only the units that become unsupported, not ones already unsupported', () => {
    expect(newlyOversold(list, { remove: 'b' })).toBe('80')
    const already = [E('s0', 'SELL', '2025-12-01T00:00:00Z', '10'), ...list]
    expect(newlyOversold(already, { remove: 'b' })).toBe('80')
  })
  it('moving the buy after the sale also leaves the sale unsupported', () => {
    expect(newlyOversold(list, { replace: { id: 'b', type: 'BUY', occurredAt: '2026-03-01T00:00:00Z', quantity: '100' } })).toBe('80')
  })
  it('ignores voided (not counted) entries', () => {
    const v = [{ ...(E('b', 'BUY', '2026-01-01T00:00:00Z', '100') as object), voided: true }, E('s', 'SELL', '2026-02-01T00:00:00Z', '80')] as never
    expect(newlyOversold(v, { remove: 's' })).toBe('0')
  })
})
