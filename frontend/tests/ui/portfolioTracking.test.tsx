import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), updateEvent: vi.fn(), eventHistory: vi.fn(),
  listAllEvents: vi.fn(), listExcluded: vi.fn(), archive: vi.fn(),
  setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const asset = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, name, symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null, ...o,
})
const pos = (assetId: string, o: Record<string, unknown> = {}) => ({
  assetId, quantity: '0', knownRemainingBasis: '0', basisComplete: true, realizedKnown: '0', realizedComplete: true,
  unresolvedSales: [], soldCount: 0, soldIncompleteCount: 0, price: null, value: null, unrealized: null, ...o,
})
const NAMES = ['MEC (Meta Earth)', 'Sidra Chain', 'InterLink Token', 'RUBI', 'VeryChat', 'Deltix Network', 'Tether USDT']
const IDS = ['MEC', 'SDA', 'ITL', 'RUBI', 'VERY', 'DLTX', 'USDT']
const tracking = { version: 1, startedAt: '2026-10-18T06:00:00Z', timezone: 'Asia/Karachi', startedToday: true, openingMarketValue: '23741.54' }

// The screenshot's portfolio: seven tokens, MEC with nothing held.
const held = (id: string, i: number) => pos(id, { quantity: String(10 + i), value: String(1000 + i), price: '100', unrealized: '5' })
const sum = (currency: 'PKR' | 'USDT' = 'PKR', root: Record<string, unknown> = {}) => ({
  currency, method: 'FIFO', fx: { usdtPkr: '280' }, fxUnavailableAssets: [], asOf: '2026-10-18T09:00:00Z',
  prices: Object.fromEntries(IDS.map((id) => [id, { price: '100', original: '100', quote: 'PKR', observedAt: '2026-10-18T05:00:00Z', source: 'platform' }])),
  summary: {
    positions: IDS.map((id, i) => (id === 'MEC' ? pos('MEC') : held(id, i))),
    pricedValue: '23741.54', knownRemainingBasis: '0', knownUnrealized: '30', knownRealized: '0', knownTotalPnl: '30',
    unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false,
  },
  assetsHeld: 6, tracking, ...root,
})
const perf = (o: Record<string, unknown> = {}) => ({
  currency: 'PKR', from: '2026-10-18T06:00:00.000Z', to: '2026-10-18T09:00:00.000Z', fxUnavailableAssets: [],
  points: [{ t: '2026-10-18T09:00:00.000Z', costBasis: '20000', realized: '0', value: '23741.54', priced: 6, held: 6, complete: true }],
  period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: '23741.54', valueEnd: '23741.54', gain: '0', gainUnavailableReason: null, returnPct: '0', returnMethod: 'MODIFIED_DIETZ' },
  tracking: { ...tracking, observations: 1 }, ...o,
})
const noImport = { dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 }

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue(IDS.map((id, i) => asset(id, NAMES[i]!)))
  api.summary.mockImplementation(async (c: 'PKR' | 'USDT' = 'PKR') => sum(c))
  api.performance.mockResolvedValue(perf())
  api.importCtm.mockResolvedValue(noImport)
  api.listEvents.mockResolvedValue([])
  api.listAllEvents.mockResolvedValue({ total: 0, items: [] })
  api.archive.mockResolvedValue({ period: null })
})

const assetsHeldValue = () => within(screen.getByText('Assets Held').closest('div')!.parentElement!).getByText(/^\d+$/).textContent

describe('assets held follows one rule: a positive balance', () => {
  it('shows 6 for seven cards when one holds nothing, and moves that one under "Not currently held"', async () => {
    render(<PortfolioPanel />)
    await screen.findByText('Holdings')
    expect(assetsHeldValue()).toBe('6')
    const notHeld = screen.getByRole('heading', { name: 'Not currently held' }).parentElement!
    expect(within(notHeld).getByRole('button', { name: 'MEC (Meta Earth)' })).toBeInTheDocument()
    expect(within(notHeld).getByText('Not held')).toBeInTheDocument()
    expect(within(notHeld).queryByText(/PKR 0\.00/)).toBeNull() // no "PKR 0.00" for something not held
    // the six held ones are in the main list
    const cards = screen.getAllByRole('button', { name: /Sidra Chain|InterLink Token|RUBI|VeryChat|Deltix Network|Tether USDT/ })
    expect(cards).toHaveLength(6)
  })
  it('the count is the same in PKR and USDT, and so are the quantities', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await screen.findByText('Holdings')
    expect(assetsHeldValue()).toBe('6')
    const before = screen.getAllByText(/ held$/).map((n) => n.textContent)
    await user.click(screen.getByRole('radio', { name: 'USDT' }))
    await screen.findAllByText(/USDT 1,0/)
    expect(api.summary).toHaveBeenLastCalledWith('USDT')
    expect(assetsHeldValue()).toBe('6')
    expect(screen.getAllByText(/ held$/).map((n) => n.textContent)).toEqual(before)
  })
  it('falls back to counting positive balances when the server did not send a count (older data)', async () => {
    api.summary.mockResolvedValue(sum('PKR', { assetsHeld: undefined }))
    render(<PortfolioPanel />)
    await screen.findByText('Holdings')
    expect(assetsHeldValue()).toBe('6')
  })
})

describe('the chart after tracking started', () => {
  it('shows the title, a single clear observation with "Tracking started today", and no table control', async () => {
    render(<PortfolioPanel />)
    expect((await screen.findAllByText('Portfolio Value Over Time')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Tracking started today/)).toBeInTheDocument()
    expect(screen.queryByText('View the data as a table')).toBeNull()
    expect(screen.getByRole('radio', { name: 'Since start' })).toBeInTheDocument()
    expect(screen.getByText(/Tracking began/)).toBeInTheDocument()
    expect(screen.getByText('Change Since Start')).toBeInTheDocument()
    expect(screen.getByText(/tracking since/)).toBeInTheDocument()
  })
  it('an unknown gain says why instead of showing a number', async () => {
    api.performance.mockResolvedValue(perf({ period: { realized: '0', realizedComplete: true, moneyIn: '0', moneyOut: '0', openingsAdded: 0, valueStart: null, valueEnd: '1', gain: null, gainUnavailableReason: 'A valid price was missing for at least one token on the day tracking started, so the starting value is not known.', returnPct: null, returnMethod: 'MODIFIED_DIETZ' } }))
    render(<PortfolioPanel />)
    expect(await screen.findByText(/missing for at least one token on the day tracking started/)).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2)
  })
  it('a range with no observations is a message, not an error', async () => {
    api.performance.mockResolvedValue(perf({ points: [] }))
    render(<PortfolioPanel />)
    expect(await screen.findByText(/No values were recorded in this range/)).toBeInTheDocument()
  })
  it('the chart still works in the old way for a portfolio with no tracking period yet', async () => {
    api.summary.mockResolvedValue(sum('PKR', { tracking: null }))
    api.performance.mockResolvedValue(perf({ tracking: undefined }))
    render(<PortfolioPanel />)
    expect((await screen.findAllByText('Portfolio Value Over Time')).length).toBeGreaterThan(0)
    expect(screen.getByRole('radio', { name: 'All time' })).toBeInTheDocument()
    expect(screen.queryByText('Change Since Start')).toBeNull()
  })
})

describe('earlier history is kept, read-only', () => {
  it('shows what could not be reconciled in plain facts and the earlier results as partial', async () => {
    api.archive.mockResolvedValue({
      period: { version: 1, startedAt: '2026-10-18T06:00:00Z', timezone: 'Asia/Karachi', reason: 'cutover' }, archivedEntries: 224,
      discrepancies: [{ kind: 'oversold_history', assetId: 'MEC', detail: 'MEC (Meta Earth): 4 sale(s) were larger than the purchases on record by 3.26 in total. The records show nothing held beyond what was bought; no units were added to cover the difference.' }],
      lifetime: { currency: 'PKR', knownRealized: '2228.06', sales: 141, salesWithUnknownResult: 82, partial: true },
    })
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /Earlier history/ }))
    expect(await screen.findByText(/224 earlier entries are kept as read-only history/)).toBeInTheDocument()
    expect(screen.getByText(/59 of 141 sales/)).toBeInTheDocument()
    expect(screen.getByText(/no units were added to cover the difference/)).toBeInTheDocument()
  })
  it("a token's history starts with the read-only opening holdings and can show the earlier entries", async () => {
    const base = {
      id: 'open:h1', assetId: 'SDA', type: 'OPENING', occurredAt: '2026-10-18T06:00:00Z', quantity: '199', consideration: null, fee: null, basis: '2200', zeroCost: false,
      quote: 'PKR', fxRate: null, fxSource: null, note: 'Holdings when tracking started (from your earlier records)', source: 'baseline', voided: false, voidReason: null, archived: false,
    }
    api.listEvents.mockImplementation(async (_id: string, scope?: string) => (scope === 'archived'
      ? [{ ...base, id: 'old1', type: 'BUY', source: 'manual', occurredAt: '2026-09-01T00:00:00Z', quantity: '209', consideration: '2400', archived: true, note: null }]
      : [base]))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: 'Sidra Chain' }))
    expect(await screen.findByText('Opening holdings')).toBeInTheDocument()
    const row = screen.getByText('Opening holdings').closest('tr')!
    expect(within(row).getByText('Read-only')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /Edit|Remove/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Show earlier history/ }))
    expect(await screen.findByText(/Kept for the record/)).toBeInTheDocument()
    expect(api.listEvents).toHaveBeenCalledWith('SDA', 'archived')
    expect(screen.getByText('2,400.00 PKR')).toBeInTheDocument()
  })
})

describe('Review no longer nags about things the app does itself', () => {
  it('a current period with no problems says so, and old-trade prices are a note', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(await screen.findByText(/Nothing needs your attention/)).toBeInTheDocument()
    expect(screen.queryByText('Sales larger than your records')).toBeNull()
  })
  it('a sale larger than the records is one concise line per token, not a list of raw quantities', async () => {
    api.summary.mockResolvedValue(sum('PKR', {
      summary: { ...sum().summary, unresolvedAssets: ['MEC'], partial: true, positions: IDS.map((id, i) => (id === 'MEC' ? pos('MEC', { unresolvedSales: [{ eventId: 'a', quantity: '2' }, { eventId: 'b', quantity: '1' }, { eventId: 'c', quantity: '0.18011547' }] }) : held(id, i))) },
    }))
    const user = userEvent.setup()
    render(<PortfolioPanel />)
    await user.click(await screen.findByRole('button', { name: /^Review/ }))
    expect(await screen.findByText('3.18011547 sold beyond your records (3 sales)')).toBeInTheDocument()
    expect(screen.queryByText(/Sold 2, 1, 0\.18/)).toBeNull()
  })
})
