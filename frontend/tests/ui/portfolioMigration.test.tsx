import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildBackup, type ExportData, type ExportEvent } from '@/lib/portfolio/exportFile'
import { encryptBackup } from '@/lib/portfolio/local/encryptedBackup'
import { migrationRequestId } from '@/components/portfolio/ImportBackupDialog'

const api = vi.hoisted(() => ({
  listAssets: vi.fn(), addAsset: vi.fn(), updateAsset: vi.fn(), summary: vi.fn(),
  listEvents: vi.fn(), addEvent: vi.fn(), deleteEvent: vi.fn(), setPrice: vi.fn(), performance: vi.fn(), importCtm: vi.fn(),
  archiveAsset: vi.fn(), unarchiveAsset: vi.fn(), deleteAsset: vi.fn(), exportAll: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ portfolioApi: api }))

import { PortfolioPanel } from '@/components/portfolio/PortfolioPanel'

const ev = (o: Partial<ExportEvent> = {}): ExportEvent => ({
  id: 'ev-1', assetId: 'g1', type: 'BUY', occurredAt: '2026-03-01T10:00:00.000Z', quantity: '10', consideration: '1000', fee: '5',
  basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null, ...o,
})
const backup = (o: Partial<ExportData> = {}): ExportData => ({
  exportedAt: '2026-10-16T10:00:00.000Z',
  assets: [
    { id: 'g1', name: 'Guest Token', symbol: 'GT', sourceUrl: 'https://gt.example/', network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    { id: 'g2', name: 'Second', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-02T00:00:00.000Z', archivedAt: null },
  ],
  events: [ev(), ev({ id: 'ev-2', occurredAt: '2026-03-02T10:00:00.000Z', quantity: '2' }), ev({ id: 'ev-3', assetId: 'g2', quantity: '5', consideration: '50' })],
  prices: [],
  ...o,
})
const file = (text: string) => new File([text], 'backup.json', { type: 'application/json' })
const accountAsset = { id: 'acc1', name: 'guest token', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00Z', archivedAt: null }

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.listAssets.mockResolvedValue([])
  api.summary.mockResolvedValue({
    currency: 'PKR', method: 'FIFO', fx: { usdtPkr: null }, fxUnavailableAssets: [], prices: {}, asOf: '2026-10-16T00:00:00Z',
    summary: { positions: [], pricedValue: '0', knownRemainingBasis: '0', knownUnrealized: '0', knownRealized: '0', knownTotalPnl: '0', unpricedAssets: [], unknownBasisAssets: [], unresolvedAssets: [], partial: false },
  })
  api.listEvents.mockResolvedValue([])
  api.performance.mockResolvedValue({})
  api.importCtm.mockResolvedValue({ dryRun: true, created: 0, restored: 0, voided: 0, alreadyImported: 0, attention: [], hasImportedBefore: false, preview: [], skippedForLimit: 0 })
  let n = 0
  api.addAsset.mockImplementation(async (d: { name: string }) => ({ id: `new-${++n}`, ...d, symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-10-16T00:00:00Z', archivedAt: null }))
  api.addEvent.mockResolvedValue({})
})

async function openDialog() {
  const user = userEvent.setup()
  render(<PortfolioPanel />)
  await user.click(await screen.findByRole('button', { name: 'Import from a backup file' }))
  return user
}

describe('availability', () => {
  it('is offered in an account even with no tokens yet', async () => {
    render(<PortfolioPanel />)
    expect(await screen.findByRole('button', { name: 'Import from a backup file' })).toBeInTheDocument()
  })
  it('is not offered where there is no account (the local tracker has no RupChain features)', async () => {
    const { importCtm: _omit, ...local } = api
    render(<PortfolioPanel api={local as never} />)
    await screen.findByText('No tracked tokens yet.')
    expect(screen.queryByRole('button', { name: 'Import from a backup file' })).toBeNull()
  })
})

describe('reviewing a backup', () => {
  it('lists each token with its entries and imports nothing until you press the button', async () => {
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
    expect(await screen.findByText('Guest Token')).toBeInTheDocument()
    expect(screen.getByText(/2 entries/)).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 tokens (3 entries)' })).toBeInTheDocument()
    expect(api.addAsset).not.toHaveBeenCalled()
    expect(api.addEvent).not.toHaveBeenCalled()
  })
  it('an invalid file is rejected with a message and imports nothing', async () => {
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file('{"hello":1}'))
    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid RupChain portfolio backup')
    expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull()
  })
  it('an encrypted backup asks for its passphrase and refuses the wrong one', async () => {
    const enc = await encryptBackup(buildBackup(backup()), 'a long enough passphrase', 100_000)
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(enc))
    await user.type(await screen.findByLabelText(/This backup is encrypted/), 'wrong wrong wrong')
    await user.click(screen.getByRole('button', { name: 'Unlock backup' }))
    expect(await screen.findByText('Wrong passphrase, or the file is damaged.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText(/This backup is encrypted/))
    await user.type(screen.getByLabelText(/This backup is encrypted/), 'a long enough passphrase')
    await user.click(screen.getByRole('button', { name: 'Unlock backup' }))
    expect(await screen.findByText('Guest Token')).toBeInTheDocument()
  })
  it('entries from RupChain trades and voided entries are not brought over, and the page says so', async () => {
    const data = backup({ events: [ev(), ev({ id: 'ev-9', source: 'ctm' }), ev({ id: 'ev-8', voided: true, voidReason: 'disputed' })] })
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(data)))
    expect(await screen.findByText(/1 entry · first/)).toBeInTheDocument()
    expect(screen.getByText(/2 not imported/)).toBeInTheDocument()
  })
  it('a token that already mirrors a RupChain token is not offered', async () => {
    const data = backup()
    data.assets[1] = { ...data.assets[1]!, linkedToRupChainToken: true }
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(data)))
    await screen.findByText('Guest Token')
    expect(screen.queryByText('Second')).toBeNull()
  })
})

describe('importing', () => {
  it('creates each selected token as NEW and adds its entries with stable request ids, then refreshes', async () => {
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
    await user.click(await screen.findByRole('button', { name: 'Import 2 tokens (3 entries)' }))
    expect(await screen.findByText(/Imported 3 entries/)).toBeInTheDocument()
    expect(api.addAsset).toHaveBeenCalledTimes(2)
    expect(api.addAsset.mock.calls[0]![0]).toMatchObject({ name: 'Guest Token', symbol: 'GT', sourceUrl: 'https://gt.example/' })
    expect(api.addEvent).toHaveBeenCalledTimes(3)
    const first = api.addEvent.mock.calls[0]!
    expect(first[0]).toBe('new-1')
    expect(first[1]).toMatchObject({ type: 'BUY', quantity: '10', consideration: '1000', fee: '5', quote: 'PKR', clientRequestId: migrationRequestId('ev-1') })
    expect(first[1].clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(api.listAssets.mock.calls.length).toBeGreaterThanOrEqual(2) // refreshed
  })
  it('unticked tokens are left out', async () => {
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
    await user.click(await screen.findByRole('checkbox', { name: /Second/ }))
    await user.click(screen.getByRole('button', { name: 'Import 1 token (2 entries)' }))
    await screen.findByText(/Imported 2 entries/)
    expect(api.addAsset).toHaveBeenCalledTimes(1)
    expect(api.addEvent.mock.calls.every((c) => c[0] === 'new-1')).toBe(true)
  })
  it('importing the same file again sends the same request ids, so nothing is recorded twice', async () => {
    const run = async () => {
      api.addEvent.mockClear()
      const user = await openDialog()
      await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
      await user.click(await screen.findByRole('button', { name: 'Import 2 tokens (3 entries)' }))
      await screen.findByText(/Imported 3 entries/)
      return api.addEvent.mock.calls.map((c) => c[1].clientRequestId)
    }
    const a = await run()
    document.body.innerHTML = ''
    const b = await run()
    expect(b).toEqual(a)
  })
  it('opening entries keep their unknown or confirmed-zero cost, and entered rates are kept', async () => {
    const data = backup({
      assets: [backup().assets[0]!],
      events: [
        ev({ id: 'o1', type: 'OPENING', consideration: null, fee: null, basis: null }),
        ev({ id: 'o2', type: 'OPENING', consideration: null, fee: null, basis: '0', zeroCost: true }),
        ev({ id: 'u1', quote: 'USDT', consideration: '36', fxRate: '278.5', fxSource: 'manual' }),
      ],
    })
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(data)))
    await user.click(await screen.findByRole('button', { name: /^Import 1 token/ }))
    await screen.findByText(/Imported 3 entries/)
    const sent = api.addEvent.mock.calls.map((c) => c[1])
    expect(sent[0]).not.toHaveProperty('basis')
    expect(sent[0]).not.toHaveProperty('zeroCost')
    expect(sent[1]).toMatchObject({ basis: '0', zeroCost: true })
    expect(sent[2]).toMatchObject({ quote: 'USDT', fxRate: '278.5' })
  })
})

describe('duplicate review (nothing is merged silently)', () => {
  it('a similar token name is only a hint; the default is still a new token', async () => {
    api.listAssets.mockResolvedValue([accountAsset])
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
    expect(await screen.findByText(/You already track a token called/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Import 2 tokens (3 entries)' }))
    await screen.findByText(/Imported 3 entries/)
    expect(api.addAsset).toHaveBeenCalledTimes(2) // not merged into "guest token"
  })
  it('entries identical to ones already in the chosen token are skipped by default, and imported if you tick the box', async () => {
    api.listAssets.mockResolvedValue([accountAsset])
    api.listEvents.mockResolvedValue([{ ...ev({ id: 'srv-1' }), assetId: 'acc1' }]) // same type, day, quantity, amount
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup({ assets: [backup().assets[0]!], events: [ev(), ev({ id: 'ev-2', occurredAt: '2026-03-02T10:00:00.000Z', quantity: '2' })] }))))
    await user.selectOptions(await screen.findByLabelText('Add these entries to'), 'acc1')
    expect(await screen.findByText(/1 entry looks identical to ones you already have/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Import 1 token/ }))
    expect(await screen.findByText(/Imported 1 entry, skipped 1 that looked identical/)).toBeInTheDocument()
    expect(api.addAsset).not.toHaveBeenCalled()
    expect(api.addEvent).toHaveBeenCalledTimes(1)
    expect(api.addEvent.mock.calls[0]![0]).toBe('acc1')
  })
  it('ticking "include" brings the identical entry too', async () => {
    api.listAssets.mockResolvedValue([accountAsset])
    api.listEvents.mockResolvedValue([{ ...ev({ id: 'srv-1' }), assetId: 'acc1' }])
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup({ assets: [backup().assets[0]!], events: [ev()] }))))
    await user.selectOptions(await screen.findByLabelText('Add these entries to'), 'acc1')
    await user.click(await screen.findByRole('checkbox', { name: /look identical|looks identical/ }))
    await user.click(screen.getByRole('button', { name: /^Import 1 token/ }))
    await screen.findByText(/Imported 1 entry/)
    expect(api.addEvent).toHaveBeenCalledTimes(1)
  })
})

describe('partial failure', () => {
  it('reports what failed, and retrying does not create the token a second time', async () => {
    api.addEvent.mockRejectedValueOnce(new Error('Date cannot be in the future')).mockResolvedValue({})
    const data = backup({ assets: [backup().assets[0]!], events: [ev(), ev({ id: 'ev-2', occurredAt: '2026-03-02T10:00:00.000Z' })] })
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(data)))
    await user.click(await screen.findByRole('button', { name: /^Import 1 token/ }))
    expect(await screen.findByText(/Imported 1 entry, 1 could not be imported/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Date cannot be in the future')
    await user.click(screen.getByRole('button', { name: 'Try the failed ones again' }))
    await vi.waitFor(() => expect(api.addEvent.mock.calls.length).toBeGreaterThan(2))
    expect(api.addAsset).toHaveBeenCalledTimes(1) // the token created the first time is reused
  })
  it('if the token itself cannot be created, its entries are counted as not imported', async () => {
    api.addAsset.mockRejectedValue(new Error('You can track up to 200 custom tokens'))
    const user = await openDialog()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file(buildBackup(backup())))
    await user.click(await screen.findByRole('button', { name: 'Import 2 tokens (3 entries)' }))
    expect(await screen.findByText(/3 could not be imported/)).toBeInTheDocument()
    expect(api.addEvent).not.toHaveBeenCalled()
  })
})

describe('migrationRequestId', () => {
  it('is stable, safe and within the server\'s limits for any id', () => {
    for (const id of ['abc-123-def', 'x', '', 'a'.repeat(200), 'weird id!!/\\', '3f2b6c1e-9d4a-4c1b-8a55-0e1f2a3b4c5d']) {
      const r = migrationRequestId(id)
      expect(r).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
      expect(migrationRequestId(id)).toBe(r)
    }
  })
})
