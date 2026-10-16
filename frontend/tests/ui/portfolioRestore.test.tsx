import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildBackup, type ExportData, type RestoreSummary } from '@/lib/portfolio/exportFile'
import { RestoreBackupDialog } from '@/components/portfolio/RestoreBackupDialog'

const data = (o: Partial<ExportData> = {}): ExportData => ({
  exportedAt: '2026-10-16T10:00:00.000Z',
  assets: [{ id: 'a1', name: 'Meta Earth', symbol: 'MEC', sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }],
  events: [{ id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: '2026-01-02T10:00:00.000Z', quantity: '100', consideration: '100000', fee: '0', basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null }],
  prices: [{ assetId: 'a1', price: '1200', quote: 'PKR', observedAt: '2026-10-01T00:00:00.000Z' }],
  revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', before: { quantity: '90' }, createdAt: '2026-02-01T00:00:00.000Z' }],
  ...o,
})
const summary = (o: Partial<RestoreSummary> = {}): RestoreSummary => ({
  assets: { created: 1, alreadyThere: 0 }, entries: { restored: 1, alreadyThere: 0, notRestored: 0 },
  prices: { restored: 1, alreadyThere: 0 }, history: { restored: 1, alreadyThere: 0, notRestored: 0 }, notes: [], ...o,
})
const file = (d: ExportData) => new File([buildBackup(d)], 'backup.json', { type: 'application/json' })

const restore = vi.fn()
const onDone = vi.fn()
beforeEach(() => { restore.mockReset(); onDone.mockReset() })

const pick = async (user: ReturnType<typeof userEvent.setup>, f: File) => {
  await user.upload(screen.getByLabelText(/Choose a backup file/), f)
}

describe('Restore from a backup file', () => {
  it('shows what is in the file, and sends nothing until the user confirms', async () => {
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    await pick(user, file(data()))
    expect(await screen.findByText(/1 token, 1 entry you typed, 1 price and 1 earlier version of corrected entries/)).toBeInTheDocument()
    expect(restore).not.toHaveBeenCalled()
  })

  it('restores on confirm, reports what happened, refreshes the tracker and passes on the notes', async () => {
    restore.mockResolvedValue(summary({ assets: { created: 0, alreadyThere: 1 }, notes: ['1 entry read from RupChain trades was not copied.'] }))
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    await pick(user, file(data()))
    await user.click(await screen.findByRole('button', { name: 'Restore this backup' }))
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore.mock.calls[0]![0].revisions).toHaveLength(1) // the history travels with it
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(/Restored 0 tokens, 1 entry, 1 price and 1 earlier version/)
    expect(status).toHaveTextContent(/Skipped what was already there: 1 token/)
    expect(status).toHaveTextContent(/1 entry read from RupChain trades was not copied/)
    expect(onDone).toHaveBeenCalled()
  })

  it('running it again when everything is already there changes nothing and does not refresh', async () => {
    restore.mockResolvedValue(summary({
      assets: { created: 0, alreadyThere: 1 }, entries: { restored: 0, alreadyThere: 1, notRestored: 0 },
      prices: { restored: 0, alreadyThere: 1 }, history: { restored: 0, alreadyThere: 0, notRestored: 0 },
    }))
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    await pick(user, file(data()))
    await user.click(await screen.findByRole('button', { name: 'Restore this backup' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Restored 0 tokens, 0 entries, 0 prices and 0 earlier versions/)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('an older backup without history says so before restoring', async () => {
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    const { revisions, ...old } = data()
    void revisions
    await pick(user, file(old))
    expect(await screen.findByText(/does not include edit history/)).toBeInTheDocument()
  })

  it('a server error is shown and nothing is reported as restored', async () => {
    restore.mockRejectedValue(new Error('Restoring would go over the limit of 200 tokens. Nothing was changed.'))
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    await pick(user, file(data()))
    await user.click(await screen.findByRole('button', { name: 'Restore this backup' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was changed/)
    expect(screen.queryByRole('status')).toBeNull()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('a file that is not a backup is rejected before anything is sent', async () => {
    const user = userEvent.setup()
    render(<RestoreBackupDialog restore={restore} onDone={onDone} onClose={() => {}} />)
    await pick(user, new File(['{"hello":1}'], 'x.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid RupChain portfolio backup/)
    expect(restore).not.toHaveBeenCalled()
  })
})
