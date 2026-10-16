import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(), exportAll: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  portfolioApi: api,
  isNetworkError: (e: unknown) => (e as { code?: string } | null)?.code === 'NETWORK_ERROR',
}))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'
import { loadQueue, loadSnapshot, saveQueue, saveSnapshot, claimCacheOwner, purgePortfolioCache, resetCacheForTests } from '@/lib/portfolio/offline/cache'
import { useAuthStore } from '@/store/auth.store'
import type { PortfolioSummaryResponse } from '@/lib/portfolio/types'

const netErr = () => Object.assign(new Error('Network error'), { code: 'NETWORK_ERROR' })
const serverErr = (m: string) => Object.assign(new Error(m), { code: 'VALIDATION_ERROR' })

const asset = { id: 'a1', name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null }
const summary = (o: Record<string, unknown> = {}): PortfolioSummaryResponse => ({
  currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T10:00:00Z',
  summary: {
    positions: [{ assetId: 'a1', quantity: '60', knownRemainingBasis: '60600', basisComplete: true, realizedKnown: '11200', realizedComplete: true, unresolvedSales: [], price: null, value: null, unrealized: null }],
    pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '11200', knownTotalPnl: '11200', unpricedAssets: ['a1'], unknownBasisAssets: [], unresolvedAssets: [], partial: true,
  },
  ...o,
}) as PortfolioSummaryResponse

let online = true
const setOnline = (v: boolean) => { online = v }

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  resetCacheForTests()
  Object.values(api).forEach((m) => m.mockReset())
  online = true
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  api.listAssets.mockResolvedValue([asset])
  api.summary.mockResolvedValue(summary())
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue({})
  api.addEvent.mockResolvedValue({})
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
})
afterEach(() => vi.restoreAllMocks())

async function recordBuy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
  await user.click(await screen.findByRole('button', { name: 'Record buy' }))
  await user.type(screen.getByLabelText('Quantity'), '10')
  await user.type(screen.getByLabelText('Amount paid (PKR)'), '1000')
  await user.click(screen.getByRole('button', { name: 'Save entry' }))
}

describe('saved copy', () => {
  it('a live view is saved on the device for next time', async () => {
    render(<PortfolioPanel userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await vi.waitFor(async () => expect((await loadSnapshot('u1'))?.assets.map((a) => a.name)).toEqual(['Meta Earth']))
  })
  it('with no connection it shows the saved copy, clearly labelled as not live', async () => {
    await saveSnapshot('u1', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    await claimCacheOwner('u1')
    api.listAssets.mockRejectedValue(netErr())
    render(<PortfolioPanel userId="u1" />)
    expect(await screen.findByRole('button', { name: /^Meta Earth/ })).toBeInTheDocument()
    const banner = screen.getByRole('region', { name: 'Connection status' })
    expect(banner).toHaveTextContent(/saved on this device on/)
    expect(banner).toHaveTextContent(/not live/)
    expect(screen.queryByText('Network error')).toBeNull() // shown as a saved copy, not as a failure
  })
  it('without a saved copy a network failure is just an error', async () => {
    api.listAssets.mockRejectedValue(netErr())
    render(<PortfolioPanel userId="u1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error')
  })
  it('a server error (not a lost connection) never falls back to old data', async () => {
    await saveSnapshot('u1', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    api.listAssets.mockRejectedValue(serverErr('Forbidden'))
    render(<PortfolioPanel userId="u1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
    expect(screen.queryByRole('button', { name: /^Meta Earth/ })).toBeNull()
  })
  it('a saved copy is never overwritten by itself (the "saved at" time stays honest)', async () => {
    await saveSnapshot('u1', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    await claimCacheOwner('u1')
    api.listAssets.mockRejectedValue(netErr())
    render(<PortfolioPanel userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await new Promise((r) => setTimeout(r, 50))
    expect((await loadSnapshot('u1'))!.savedAt).toBe('2026-10-15T08:30:00.000Z')
  })
  it('the local-only tracker and anonymous use never touch this cache', async () => {
    const { importCtm: _omit, ...local } = api
    render(<PortfolioPanel api={local as never} userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await new Promise((r) => setTimeout(r, 50))
    expect(await loadSnapshot('u1')).toBeUndefined()
    expect(screen.queryByRole('region', { name: 'Connection status' })).toBeNull()
  })
})

describe('entries recorded offline', () => {
  it('while offline an entry is kept on the device, not sent, and the form closes', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    setOnline(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    await recordBuy(user)
    expect(api.addEvent).not.toHaveBeenCalled()
    expect(await screen.findByText(/1 entry is waiting to be sent/)).toBeInTheDocument()
    expect(screen.getByText(/Buy 10 Meta Earth for 1,000.00 PKR/)).toBeInTheDocument()
    expect(screen.queryByRole('form')).toBeNull()
    expect((await loadQueue('u1'))).toHaveLength(1)
  })
  it('when the connection returns, the entry is sent once with the SAME request id and the queue empties', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    setOnline(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    await recordBuy(user)
    const queued = (await loadQueue('u1'))[0]!
    setOnline(true)
    act(() => { window.dispatchEvent(new Event('online')) })
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![0]).toBe('a1')
    expect(api.addEvent.mock.calls[0]![1].clientRequestId).toBe(queued.input.clientRequestId)
    await vi.waitFor(async () => expect(await loadQueue('u1')).toHaveLength(0))
    await vi.waitFor(() => expect(screen.queryByText(/waiting to be sent/)).toBeNull())
  })
  it('a connection that drops during the save also queues it, and a lost reply cannot double-record (same id)', async () => {
    api.addEvent.mockRejectedValueOnce(netErr()).mockResolvedValue({})
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await recordBuy(user)
    expect(await screen.findByText(/1 entry is waiting to be sent/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send now' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(2))
    expect(api.addEvent.mock.calls[1]![1].clientRequestId).toBe(api.addEvent.mock.calls[0]![1].clientRequestId)
  })
  it('if the network is still down during sending, nothing is lost', async () => {
    api.addEvent.mockRejectedValue(netErr())
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await recordBuy(user)
    await user.click(await screen.findByRole('button', { name: 'Send now' }))
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(2))
    expect(await loadQueue('u1')).toHaveLength(1)
    expect((await loadQueue('u1'))[0]!.status).toBe('pending')
  })
  it('an entry the server refuses is flagged with the reason, not silently dropped, and can be discarded or retried', async () => {
    api.addEvent.mockRejectedValueOnce(netErr()).mockRejectedValueOnce(serverErr('Date cannot be in the future')).mockResolvedValue({})
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await recordBuy(user)
    await user.click(await screen.findByRole('button', { name: 'Send now' }))
    expect(await screen.findByText(/1 entry was refused and not saved/)).toBeInTheDocument()
    expect(screen.getByText(/Date cannot be in the future/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await vi.waitFor(async () => expect(await loadQueue('u1')).toHaveLength(0))
  })
  it('a queued entry can be discarded before it is sent', async () => {
    api.addEvent.mockRejectedValue(netErr())
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await recordBuy(user)
    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(await loadQueue('u1')).toHaveLength(0)
    expect(screen.queryByText(/waiting to be sent/)).toBeNull()
  })
  it('entries still waiting from an earlier visit are sent as soon as the tracker opens online', async () => {
    await claimCacheOwner('u1')
    await saveQueue('u1', [{
      id: 'req-12345678', assetId: 'a1', assetName: 'Meta Earth', queuedAt: '2026-10-15T09:00:00.000Z', status: 'pending',
      input: { type: 'BUY', occurredAt: '2026-10-15T08:59:00.000Z', quantity: '3', consideration: '300', quote: 'PKR', clientRequestId: 'req-12345678' },
    }])
    render(<PortfolioPanel userId="u1" />)
    await vi.waitFor(() => expect(api.addEvent).toHaveBeenCalledTimes(1))
    expect(api.addEvent.mock.calls[0]![1]).toMatchObject({ clientRequestId: 'req-12345678', quantity: '3' })
  })
  it('a price cannot be queued: it needs a connection, and says so', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await user.click(await screen.findByRole('button', { name: /^Meta Earth/ }))
    await user.click(await screen.findByRole('button', { name: 'Update current price' }))
    setOnline(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    await user.type(screen.getByLabelText(/Current price per unit/), '1200')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    expect(await screen.findByText(/Prices need a connection/)).toBeInTheDocument()
    expect(api.setPrice).not.toHaveBeenCalled()
  })
  it('nothing that moves money can be queued: the queue only ever holds recorded entries', async () => {
    const user = userEvent.setup()
    render(<PortfolioPanel userId="u1" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    setOnline(false)
    act(() => { window.dispatchEvent(new Event('offline')) })
    await recordBuy(user)
    const q = await loadQueue('u1')
    expect(q.every((x) => ['BUY', 'SELL', 'OPENING'].includes(x.input.type))).toBe(true)
    expect(Object.keys(q[0]!.input).sort()).toEqual(['clientRequestId', 'consideration', 'occurredAt', 'quantity', 'quote', 'type'])
  })
})

describe('privacy on a shared device', () => {
  it('a different user opening the tracker wipes the previous user\'s saved copy and queue', async () => {
    await claimCacheOwner('alice')
    await saveSnapshot('alice', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    await saveQueue('alice', [{ id: 'x', assetId: 'a1', assetName: 'Meta Earth', queuedAt: '2026-10-15T09:00:00.000Z', status: 'pending', input: { type: 'BUY', occurredAt: '2026-10-15T08:59:00.000Z', quantity: '1', consideration: '1' } }])
    render(<PortfolioPanel userId="bob" />)
    await screen.findByRole('button', { name: /^Meta Earth/ })
    await vi.waitFor(async () => {
      expect(await loadSnapshot('alice')).toBeUndefined()
      expect(await loadQueue('alice')).toEqual([])
    })
    expect(api.addEvent).not.toHaveBeenCalled() // Alice's queued entry is NOT sent under Bob's session
  })
  it('after a different user is seen, the old saved copy can never be shown offline', async () => {
    await claimCacheOwner('alice')
    await saveSnapshot('alice', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    api.listAssets.mockRejectedValue(netErr())
    render(<PortfolioPanel userId="bob" />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Meta Earth/ })).toBeNull()
  })
  it('logging out deletes the saved copy and the queue', async () => {
    await claimCacheOwner('u1')
    await saveSnapshot('u1', { savedAt: '2026-10-15T08:30:00.000Z', currency: 'PKR', assets: [asset], summary: summary() })
    await saveQueue('u1', [{ id: 'x', assetId: 'a1', assetName: 'A', queuedAt: '2026-10-15T09:00:00.000Z', status: 'pending', input: { type: 'BUY', occurredAt: '2026-10-15T08:59:00.000Z', quantity: '1', consideration: '1' } }])
    useAuthStore.getState().clearAuth()
    await vi.waitFor(async () => {
      expect(await loadSnapshot('u1')).toBeUndefined()
      expect(await loadQueue('u1')).toEqual([])
    })
  })
  it('purging never throws, even with storage unavailable', async () => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    resetCacheForTests()
    await expect(purgePortfolioCache()).resolves.toBeUndefined()
  })
})
