import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { resolvePeriod, parseLocalDate } from '@/lib/portfolio/periods'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { LineChart } from '@/components/portfolio/LineChart'

describe('period resolution (device time zone)', () => {
  const now = new Date(2026, 9, 16, 15, 30, 0) // 16 Oct 2026, 15:30 local

  it('"this month" starts at local midnight on the 1st', () => {
    const r = resolvePeriod('month', now) as { from: Date; to: Date }
    expect([r.from.getFullYear(), r.from.getMonth(), r.from.getDate(), r.from.getHours(), r.from.getMinutes()]).toEqual([2026, 9, 1, 0, 0])
    expect(r.to).toBe(now)
  })
  it('7D, 30D and 90D look back that many days', () => {
    for (const [p, d] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const r = resolvePeriod(p, now) as { from: Date; to: Date }
      expect(Math.round((now.getTime() - r.from.getTime()) / 86_400_000)).toBe(d)
    }
  })
  it('all time has no start (the server uses the first entry)', () => {
    expect((resolvePeriod('all', now) as { from?: Date }).from).toBeUndefined()
  })
  it('custom covers whole days and never reaches into the future', () => {
    const r = resolvePeriod('custom', now, { from: '2026-10-01', to: '2026-10-10' }) as { from: Date; to: Date }
    expect(r.from.getDate()).toBe(1)
    expect([r.to.getDate(), r.to.getHours(), r.to.getMinutes()]).toEqual([10, 23, 59])
    const future = resolvePeriod('custom', now, { from: '2026-10-01', to: '2030-01-01' }) as { to: Date }
    expect(future.to).toBe(now)
  })
  it.each([
    [{ from: '', to: '' }], [{ from: '2026-10-10', to: '2026-10-01' }], [{ from: '2031-01-01', to: '2031-02-01' }], [{ from: '2026-02-31', to: '2026-03-01' }],
  ])('rejects the invalid custom range %j', (c) => {
    expect(resolvePeriod('custom', now, c)).toHaveProperty('error')
  })
  it('only real calendar dates parse', () => {
    expect(parseLocalDate('2026-02-28')).not.toBeNull()
    expect(parseLocalDate('2026-02-30')).toBeNull()
    expect(parseLocalDate('26-2-3')).toBeNull()
  })
})

describe('LineChart', () => {
  const s = (points: Array<[string, string | null]>) => ({
    name: 'Marked value', marker: 'circle' as const, className: 'stroke-primary fill-primary', points: points.map(([t, v]) => ({ t, v })),
  })

  it('shows a clear message instead of an empty chart when nothing is known', () => {
    render(<LineChart title="Value" description="d" currency="PKR" emptyMessage="Enter a price first." series={[s([['2026-01-01T00:00:00Z', null]])]} />)
    expect(screen.getByText('Enter a price first.')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('is labelled for assistive tech: title, a text description of the values, and no data table', () => {
    const { container } = render(<LineChart title="Value over time" description="Shows value." currency="PKR" emptyMessage="x"
      series={[s([['2026-01-01T00:00:00Z', '1000'], ['2026-01-02T00:00:00Z', '1500']])]} />)
    expect(screen.getByRole('img', { name: 'Value over time' })).toBeInTheDocument()
    expect(screen.queryByText('View the data as a table')).toBeNull()
    expect(container.querySelector('table')).toBeNull()
    const desc = container.querySelector('svg[role="img"] desc')!.textContent!
    expect(desc).toMatch(/2 known values, latest PKR 1,500.00/)
    expect(desc).toMatch(/lowest PKR 1,000.00, highest PKR 1,500.00/)
  })
  it('reads exact values with the arrow keys and on pointer move (tooltip), and states the currency', async () => {
    const user = userEvent.setup()
    const { container } = render(<LineChart title="Value" description="d" currency="USDT" emptyMessage="x"
      series={[s([['2026-01-01T00:00:00Z', '1000'], ['2026-01-02T00:00:00Z', '1500'], ['2026-01-03T00:00:00Z', null]])]} />)
    const svg = container.querySelector('svg[role="img"]') as SVGSVGElement
    expect(svg.textContent).toContain('USDT') // axis unit label
    await user.tab()
    expect(svg).toHaveFocus()
    // focus reads the latest point (a gap), then Left moves to the previous known one
    expect(screen.getAllByText(/Not known/).length).toBeGreaterThan(0)
    await user.keyboard('{ArrowLeft}')
    expect(screen.getAllByText('USDT 1,500.00').length).toBeGreaterThan(0)
    await user.keyboard('{Home}')
    expect(screen.getAllByText('USDT 1,000.00').length).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    expect(screen.queryByText('USDT 1,000.00', { selector: 'p.whitespace-nowrap span' })).toBeNull()
  })
  it('a single observation is a clear point with the note, never a trend line', () => {
    const { container } = render(<LineChart title="V" description="d" currency="PKR" emptyMessage="x" singleNote="Tracking started today."
      series={[s([['2026-10-18T09:00:00Z', '23741.54']])]} />)
    expect(container.querySelectorAll('svg[role="img"] polyline')).toHaveLength(0)
    expect(container.querySelectorAll('svg[role="img"] circle')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Tracking started today.')
  })
  it('draws a gap as a break: two separate lines, never a joined one', () => {
    const { container } = render(<LineChart title="V" description="d" currency="PKR" emptyMessage="x"
      series={[s([['2026-01-01T00:00:00Z', '1'], ['2026-01-02T00:00:00Z', '2'], ['2026-01-03T00:00:00Z', null], ['2026-01-04T00:00:00Z', '3'], ['2026-01-05T00:00:00Z', '4']])]} />)
    expect(container.querySelectorAll('svg[role="img"] polyline')).toHaveLength(2)
    expect(screen.getByText(/Gaps mean the value is unknown/)).toBeInTheDocument()
    expect(container.querySelector('svg[role="img"] desc')!.textContent).toMatch(/1 date with an unknown value/)
  })
  it('a single known point is drawn as a marker, not as a line', () => {
    const { container } = render(<LineChart title="V" description="d" currency="PKR" emptyMessage="x"
      series={[s([['2026-01-01T00:00:00Z', null], ['2026-01-02T00:00:00Z', '5'], ['2026-01-03T00:00:00Z', null]])]} />)
    expect(container.querySelectorAll('svg[role="img"] polyline')).toHaveLength(0)
    expect(container.querySelectorAll('svg[role="img"] circle')).toHaveLength(1)
  })
  it('series differ by dash and marker shape, not colour alone', () => {
    const { container } = render(<LineChart title="V" description="d" currency="PKR" emptyMessage="x" series={[
      { name: 'A', marker: 'circle', className: 'stroke-primary fill-primary', points: [{ t: '2026-01-01T00:00:00Z', v: '1' }, { t: '2026-01-02T00:00:00Z', v: '2' }] },
      { name: 'B', marker: 'square', dash: '6 4', className: 'stroke-text-secondary fill-text-secondary', points: [{ t: '2026-01-01T00:00:00Z', v: '2' }, { t: '2026-01-02T00:00:00Z', v: '3' }] },
    ]} />)
    const lines = container.querySelectorAll('svg[role="img"] polyline')
    expect(lines[0]!.getAttribute('stroke-dasharray')).toBeNull()
    expect(lines[1]!.getAttribute('stroke-dasharray')).toBe('6 4')
  })
  it('handles a flat series without dividing by zero', () => {
    const { container } = render(<LineChart title="V" description="d" currency="PKR" emptyMessage="x"
      series={[s([['2026-01-01T00:00:00Z', '7'], ['2026-01-02T00:00:00Z', '7']])]} />)
    const pts = container.querySelector('polyline')!.getAttribute('points')!
    expect(pts).not.toMatch(/NaN|Infinity/)
  })
})

const asset = { id: 'MEC', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null }
const summary = {
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: {
    positions: [{ assetId: 'MEC', quantity: '60', knownRemainingBasis: '60600', basisComplete: true, realizedKnown: '11200', realizedComplete: true, unresolvedSales: [], price: null, value: null, unrealized: null }],
    pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '11200', knownTotalPnl: '11200',
    unpricedAssets: ['MEC'], unknownBasisAssets: [], unresolvedAssets: [], partial: true,
  },
}
const perf = (o: Record<string, unknown> = {}) => ({
  currency: 'PKR', from: '2026-01-01T00:00:00.000Z', to: '2026-10-16T00:00:00.000Z', fxUnavailableAssets: [],
  points: [
    { t: '2026-01-01T00:00:00.000Z', costBasis: '101000', realized: '0', value: null, priced: 0, held: 1, complete: true },
    { t: '2026-10-16T00:00:00.000Z', costBasis: '60600', realized: '11200', value: '72000', priced: 1, held: 1, complete: true },
  ],
  period: {
    realized: '11200', realizedComplete: true, moneyIn: '101000', moneyOut: '51600', openingsAdded: 0, valueStart: null, valueEnd: '72000',
    gain: null, gainUnavailableReason: 'A price is missing at the start or the end of this period.', returnPct: null, returnMethod: 'MODIFIED_DIETZ', ...o,
  },
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([asset])
  api.summary.mockResolvedValue(summary)
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue(perf())
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})

describe('PerformanceSection inside the Portfolio tab', () => {
  it('loads "all time" by default in the shown currency and renders results and both charts', async () => {
    render(<PortfolioPanel />)
    expect(await screen.findByText('Buy Costs + Fees')).toBeInTheDocument()
    const first = api.performance.mock.calls[0]![0]
    expect(first.currency).toBe('PKR')
    expect(first.from).toBeUndefined()
    expect(first.to).toMatch(/^\d{4}-/)
    expect(screen.getAllByText('PKR +11,200.00').length).toBeGreaterThanOrEqual(2) // headline card and period card
    expect(screen.getByText('PKR 101,000.00')).toBeInTheDocument()
    expect(screen.getByText('PKR 51,600.00')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Cost and Realized Profit Over Time' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Portfolio Value Over Time' })).toBeInTheDocument()
  })
  it('never shows a percentage or a gain when they are unavailable, and says why', async () => {
    render(<PortfolioPanel />)
    expect(await screen.findByText(/A price is missing at the start or the end/)).toBeInTheDocument()
    expect(screen.getByText('Return unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Approximate (Modified Dietz)')).toBeNull()
  })
  it('shows the Modified Dietz percentage only when the server provides one, labelled as an approximation', async () => {
    api.performance.mockResolvedValue(perf({ gain: '400', gainUnavailableReason: null, returnPct: '26.67', valueStart: '1000', valueEnd: '2400' }))
    render(<PortfolioPanel />)
    expect(await screen.findByText('26.67%')).toBeInTheDocument()
    expect(screen.getByText('Approximate (Modified Dietz)')).toBeInTheDocument()
    expect(screen.getByText('PKR +400.00')).toBeInTheDocument()
  })
  it('choosing a period reloads with a start date; "All time" has none', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    await user.click(screen.getByRole('radio', { name: '30D' }))
    await vi.waitFor(() => expect(api.performance.mock.calls.length).toBeGreaterThan(1))
    const last = api.performance.mock.calls.at(-1)![0]
    expect(Math.round((Date.parse(last.to) - Date.parse(last.from)) / 86_400_000)).toBe(30)
    expect(screen.getByRole('radio', { name: '30D' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: 'All time' }))
    await vi.waitFor(() => expect(api.performance.mock.calls.at(-1)![0].from).toBeUndefined())
  })
  it('custom period asks for dates, validates them, then loads', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    const before = api.performance.mock.calls.length
    await user.click(screen.getByRole('radio', { name: 'Custom' }))
    expect(await screen.findByText('Choose a start and an end date.')).toBeInTheDocument()
    expect(api.performance.mock.calls.length).toBe(before)
    await user.type(screen.getByLabelText('From'), '2026-10-10')
    await user.type(screen.getByLabelText('To'), '2026-10-01')
    expect(await screen.findByText('The start date must be before the end date.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('To'))
    await user.type(screen.getByLabelText('To'), '2026-10-12')
    await vi.waitFor(() => expect(api.performance.mock.calls.length).toBeGreaterThan(before))
    expect(api.performance.mock.calls.at(-1)![0].from).toMatch(/^2026-10-/)
  })
  it('reloads when the currency changes and when records change', async () => {
    const user = userEvent.setup()
    api.summary.mockImplementation(async (c: string) => ({ ...summary, currency: c, asOf: c === 'USDT' ? '2026-10-16T11:00:00Z' : summary.asOf }))
    api.performance.mockImplementation(async ({ currency }: { currency: string }) => ({ ...perf(), currency }))
    render(<PortfolioPanel />)
    await screen.findByText('Buy Costs + Fees')
    await user.click(screen.getByRole('radio', { name: 'USDT' }))
    await vi.waitFor(() => expect(api.performance.mock.calls.some((c) => c[0].currency === 'USDT')).toBe(true))
  })
  it('shows an error without hiding the rest of the portfolio', async () => {
    api.performance.mockRejectedValue(new Error('Server is busy'))
    render(<PortfolioPanel />)
    expect(await screen.findByText('Server is busy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Meta Earth/ })).toBeInTheDocument()
  })
  it('is not shown for a portfolio with nothing recorded', async () => {
    api.summary.mockResolvedValue({ ...summary, summary: { ...summary.summary, positions: [], unpricedAssets: [], partial: false } })
    render(<PortfolioPanel />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    expect(screen.queryByText('Results over time')).toBeNull()
    expect(api.performance).not.toHaveBeenCalled()
  })
})
