import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExcludedTradesView } from '@/components/portfolio/ExcludedTradesView'
import { EventForm } from '@/components/portfolio/EventForm'

const trade = (id: string, o: Record<string, unknown> = {}) => ({
  tradeId: id, tradeRef: `CTM-${id}`, tokenName: 'Rubi', side: 'BUY', quantity: '10', consideration: '100', quote: 'PKR',
  date: '2026-10-01T10:00:00.000Z', reason: 'disputed', recorded: false, canRecord: true, ...o,
})
const page = (items: unknown[], recordable?: number) => ({ total: items.length, ...(recordable !== undefined ? { recordable } : {}), items })

function setup(items: unknown[], batch: ReturnType<typeof vi.fn>, recordable?: number) {
  window.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  const load = vi.fn().mockResolvedValue(page(items, recordable))
  render(<ExcludedTradesView load={load as never} onRecord={vi.fn()} onRecordBatch={batch as never} onBack={() => {}} currency="PKR" />)
  return { load, user: userEvent.setup() }
}
const ok = { recorded: 2, alreadyRecorded: 0, skipped: 0, failed: 0, results: [] }

describe('Record all', () => {
  it('offers Record all with the number of trades that can be recorded, across all pages', async () => {
    setup([trade('1'), trade('2')], vi.fn(), 40)
    expect(await screen.findByRole('button', { name: 'Record all (40)' })).toBeInTheDocument()
  })

  it('needs an explicit confirmation before anything is sent', async () => {
    const batch = vi.fn().mockResolvedValue(ok)
    const { user } = setup([trade('1'), trade('2')], batch)
    await user.click(await screen.findByRole('button', { name: /^Record all/ }))
    const confirm = screen.getByRole('region', { name: 'Confirm recording' })
    const go = within(confirm).getByRole('button', { name: /^Record 2 trades/ })
    expect(go).toBeDisabled()
    expect(batch).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('checkbox'))
    await user.click(go)
    await vi.waitFor(() => expect(batch).toHaveBeenCalledTimes(1))
    expect(batch).toHaveBeenCalledWith({ all: true })
  })

  it('sends only the chosen trades and shows the summary afterwards', async () => {
    const batch = vi.fn().mockResolvedValue({ ...ok, recorded: 1 })
    const { user } = setup([trade('1'), trade('2')], batch)
    await user.click(await screen.findByRole('checkbox', { name: 'Select trade CTM-2' }))
    await user.click(screen.getByRole('button', { name: 'Record selected (1)' }))
    await user.click(within(screen.getByRole('region', { name: 'Confirm recording' })).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Record 1 trade' }))
    expect(batch).toHaveBeenCalledWith({ tradeIds: ['2'] })
    expect(await screen.findByText('Recorded 1 trade')).toBeInTheDocument()
    expect(screen.getByText('Everything went through.')).toBeInTheDocument()
  })

  it('cannot select trades that cannot be recorded or are already recorded', async () => {
    setup([trade('1'), trade('2', { canRecord: false, reason: 'in_progress' }), trade('3', { recorded: true })], vi.fn())
    await screen.findByRole('checkbox', { name: 'Select trade CTM-1' })
    expect(screen.queryByRole('checkbox', { name: 'Select trade CTM-2' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Select trade CTM-3' })).toBeNull()
  })

  it('reports a partial failure per trade and lets the failed ones be retried', async () => {
    const batch = vi.fn()
      .mockResolvedValueOnce({ recorded: 1, alreadyRecorded: 0, skipped: 0, failed: 1, results: [{ tradeId: '2', tradeRef: 'CTM-2', outcome: 'failed', message: 'Could not be saved. Try again.' }] })
      .mockResolvedValueOnce({ ...ok, recorded: 1 })
    const { user } = setup([trade('1'), trade('2')], batch)
    await user.click(await screen.findByRole('button', { name: /^Record all/ }))
    await user.click(within(screen.getByRole('region', { name: 'Confirm recording' })).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Record 2 trades' }))
    expect(await screen.findByText(/1 could not be saved/)).toBeInTheDocument()
    expect(screen.getByText('CTM-2: Could not be saved. Try again.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try the failed ones again' }))
    await user.click(within(screen.getByRole('region', { name: 'Confirm recording' })).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Record 1 trade' }))
    expect(batch).toHaveBeenLastCalledWith({ tradeIds: ['2'] })
  })

  it('shows the error and keeps the confirmation open when the request fails', async () => {
    const batch = vi.fn().mockRejectedValue(new Error('Network down'))
    const { user } = setup([trade('1')], batch)
    await user.click(await screen.findByRole('button', { name: /^Record all/ }))
    await user.click(within(screen.getByRole('region', { name: 'Confirm recording' })).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Record 1 trade' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down')
    expect(screen.getByRole('region', { name: 'Confirm recording' })).toBeInTheDocument()
  })

  it('is not offered when the account cannot record in bulk, or nothing can be recorded', async () => {
    window.scrollTo = vi.fn()
    const load = vi.fn().mockResolvedValue(page([trade('1')]))
    const { unmount } = render(<ExcludedTradesView load={load as never} onRecord={vi.fn()} onBack={() => {}} currency="PKR" />)
    await screen.findByText('CTM-1')
    expect(screen.queryByRole('button', { name: /^Record all/ })).toBeNull()
    unmount()
    render(<ExcludedTradesView load={vi.fn().mockResolvedValue(page([trade('1', { canRecord: false })])) as never} onRecord={vi.fn()} onRecordBatch={vi.fn() as never} onBack={() => {}} currency="PKR" />)
    await screen.findByText('CTM-1')
    expect(screen.queryByRole('button', { name: /^Record all/ })).toBeNull()
  })
})

describe('automatic conversion in the entry form', () => {
  const form = (props: Record<string, unknown> = {}) => render(<EventForm assetName="Rubi" onSubmit={vi.fn()} onCancel={() => {}} usdtPkr="280" {...props} />)

  it('shows PKR entered as USDT at the current RupChain rate', async () => {
    const user = userEvent.setup()
    form()
    await user.type(screen.getByLabelText('Quantity'), '5')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '2800')
    expect(screen.getByTestId('conversion-note')).toHaveTextContent("About USDT 10.0000 at today's RupChain rate (280.00 PKR per USDT).")
  })

  it('shows USDT entered as PKR, and follows the amount', async () => {
    const user = userEvent.setup()
    form({ defaultCurrency: 'USDT' })
    await user.type(screen.getByLabelText('Quantity'), '5')
    await user.type(screen.getByLabelText('Amount paid (USDT)'), '3.5')
    expect(screen.getByTestId('conversion-note')).toHaveTextContent('About PKR 980.00')
    await user.clear(screen.getByLabelText('Amount paid (USDT)'))
    await user.type(screen.getByLabelText('Amount paid (USDT)'), '4')
    expect(screen.getByTestId('conversion-note')).toHaveTextContent('About PKR 1,120.00')
  })

  it('never applies today\'s rate to a past date, and says so', async () => {
    const user = userEvent.setup()
    form()
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '2800')
    const date = screen.getByLabelText('Date and time')
    await user.clear(date)
    await user.type(date, '2026-01-02T10:00')
    const note = screen.getByTestId('conversion-note')
    expect(note).toHaveTextContent('No exchange rate is stored for past dates')
    expect(note).not.toHaveTextContent('About')
  })

  it('has no manual rate field', () => {
    form()
    expect(screen.queryByLabelText(/USDT\/PKR rate/)).toBeNull()
  })

  it('shows no conversion when there is no current rate', async () => {
    const user = userEvent.setup()
    form({ usdtPkr: null })
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '2800')
    expect(screen.queryByText(/About USDT/)).toBeNull()
  })
})
