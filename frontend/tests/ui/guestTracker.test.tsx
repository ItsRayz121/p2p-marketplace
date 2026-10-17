import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { GuestTracker, GUEST_DB } from '@/components/portfolio/GuestTracker'
import { openStore } from '@/lib/portfolio/local/idb'
import { parseBackup } from '@/lib/portfolio/exportFile'
import { decryptBackup } from '@/lib/portfolio/local/encryptedBackup'

const readBlob = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(b) })

let blobs: Blob[]
let downloads: string[]
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  blobs = []; downloads = []
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:t' }, revokeObjectURL: () => {} }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function addToken(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: 'Add asset' }))
  await user.type(screen.getByLabelText('Token name'), name)
  await user.click(screen.getByRole('button', { name: 'Add token' }))
  await screen.findByRole('button', { name: new RegExp(name) })
}

describe('the page', () => {
  it('says plainly that nothing leaves the browser and that it is only an estimate', async () => {
    render(<GuestTracker />)
    expect(await screen.findByText(/stays in this browser: nothing is uploaded/)).toBeInTheDocument()
    expect(screen.getByText(/not verified ownership/)).toBeInTheDocument()
    expect(screen.getByText(/exist only in this browser/)).toBeInTheDocument()
  })
  it('offers no account-only features (RupChain trade import, listing suggestions)', async () => {
    const user = userEvent.setup()
    render(<GuestTracker />)
    await addToken(user, 'Alpha')
    await user.click(screen.getByRole('button', { name: /^Alpha/ }))
    expect(screen.queryByText(/Suggest this token for listing/)).toBeNull()
    expect(screen.queryByText(/RupChain trades/)).toBeNull()
  })
  it('works without an account and makes no network request while adding, recording, valuing and exporting', async () => {
    const user = userEvent.setup()
    render(<GuestTracker />)
    await addToken(user, 'Alpha')
    await user.click(screen.getByRole('button', { name: /^Alpha/ }))
    await user.click(await screen.findByRole('button', { name: 'Record Transaction' }))
    await user.type(screen.getByLabelText('Quantity'), '10')
    await user.type(screen.getByLabelText('Amount paid (PKR)'), '1000')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('1,000.00 PKR')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Update price' }))
    await user.type(screen.getByLabelText(/Price per unit/), '150')
    await user.click(screen.getByRole('button', { name: 'Save price' }))
    expect(await screen.findByText('1,500.00')).toBeInTheDocument() // marked value, from the local engine
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('keeps your data for the next visit', async () => {
    const user = userEvent.setup()
    const first = render(<GuestTracker />)
    await addToken(user, 'Remember me')
    first.unmount()
    render(<GuestTracker />)
    expect(await screen.findByRole('button', { name: /Remember me/ })).toBeInTheDocument()
  })
  it('warns when the browser blocks storage', async () => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    render(<GuestTracker />)
    expect(await screen.findByText(/blocking storage/)).toBeInTheDocument()
  })
  it('explains when saved data was unreadable and set aside', async () => {
    const store = await openStore(GUEST_DB)
    await store.set('data', { assets: 'garbage' })
    render(<GuestTracker />)
    expect(await screen.findByText(/could not be read, so it was set aside/)).toBeInTheDocument()
  })
  it('saves a typed-in USDT/PKR rate on this device and rejects a bad one', async () => {
    const user = userEvent.setup()
    render(<GuestTracker />)
    const input = await screen.findByLabelText('Current USDT/PKR rate')
    await user.type(input, '0')
    await user.click(screen.getByRole('button', { name: 'Save rate' }))
    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '281.5')
    await user.click(screen.getByRole('button', { name: 'Save rate' }))
    expect(await screen.findByText('Rate saved on this device.')).toBeInTheDocument()
  })
})

describe('backup, restore and erase', () => {
  async function withOneToken() {
    const user = userEvent.setup()
    const view = render(<GuestTracker />)
    await addToken(user, 'Alpha')
    return { user, view }
  }

  it('downloads a plain backup that the app can read back', async () => {
    const { user } = await withOneToken()
    await user.click(screen.getByRole('button', { name: /Download plain backup/ }))
    expect(downloads[0]).toMatch(/^rupchain-portfolio-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const parsed = parseBackup(await readBlob(blobs[0]!))
    expect(parsed.ok && parsed.data.assets.map((a) => a.name)).toEqual(['Alpha'])
  })
  it('an encrypted backup needs two matching passphrases and does not contain the data in the clear', async () => {
    const { user } = await withOneToken()
    await user.type(screen.getByLabelText('Passphrase for an encrypted backup'), 'short')
    await user.click(screen.getByRole('button', { name: 'Download encrypted backup' }))
    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Passphrase for an encrypted backup'))
    await user.type(screen.getByLabelText('Passphrase for an encrypted backup'), 'a long enough passphrase')
    await user.type(screen.getByLabelText('Repeat the passphrase'), 'a different passphrase!')
    await user.click(screen.getByRole('button', { name: 'Download encrypted backup' }))
    expect(await screen.findByText('The two passphrases do not match.')).toBeInTheDocument()
    expect(blobs).toHaveLength(0)
    await user.clear(screen.getByLabelText('Repeat the passphrase'))
    await user.type(screen.getByLabelText('Repeat the passphrase'), 'a long enough passphrase')
    await user.click(screen.getByRole('button', { name: 'Download encrypted backup' }))
    await vi.waitFor(() => expect(blobs).toHaveLength(1), { timeout: 10_000 })
    const text = await readBlob(blobs[0]!)
    expect(text).not.toContain('Alpha')
    const back = await decryptBackup(text, 'a long enough passphrase')
    expect(back.ok).toBe(true)
  }, 30_000)

  it('restores a plain backup into an empty tracker', async () => {
    const { user, view } = await withOneToken()
    await user.click(screen.getByRole('button', { name: /Download plain backup/ }))
    const file = new File([await readBlob(blobs[0]!)], 'backup.json', { type: 'application/json' })
    view.unmount()
    ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory() // a different browser
    render(<GuestTracker />)
    await user.upload(await screen.findByLabelText('Choose a backup file (.json)'), file)
    expect(await screen.findByText(/This backup has 1 token and 0 entries/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore this backup' }))
    expect(await screen.findByText('Restored 1 token and 0 entries.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Alpha/ })).toBeInTheDocument()
  })
  it('restoring over existing data warns first', async () => {
    const { user } = await withOneToken()
    await user.click(screen.getByRole('button', { name: /Download plain backup/ }))
    const file = new File([await readBlob(blobs[0]!)], 'b.json', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), file)
    expect(await screen.findByText(/Restoring replaces what is on this device now \(1 token, 0 entries\)/)).toBeInTheDocument()
  })
  it('an encrypted backup asks for the passphrase, refuses the wrong one, then restores', async () => {
    const { user, view } = await withOneToken()
    await user.type(screen.getByLabelText('Passphrase for an encrypted backup'), 'a long enough passphrase')
    await user.type(screen.getByLabelText('Repeat the passphrase'), 'a long enough passphrase')
    await user.click(screen.getByRole('button', { name: 'Download encrypted backup' }))
    await vi.waitFor(() => expect(blobs).toHaveLength(1), { timeout: 10_000 })
    const file = new File([await readBlob(blobs[0]!)], 'enc.json', { type: 'application/json' })
    view.unmount()
    ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    render(<GuestTracker />)
    await user.upload(await screen.findByLabelText('Choose a backup file (.json)'), file)
    await user.type(await screen.findByLabelText(/This backup is encrypted/), 'not the passphrase!')
    await user.click(screen.getByRole('button', { name: 'Unlock backup' }))
    expect(await screen.findByText('Wrong passphrase, or the file is damaged.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText(/This backup is encrypted/))
    await user.type(screen.getByLabelText(/This backup is encrypted/), 'a long enough passphrase')
    await user.click(screen.getByRole('button', { name: 'Unlock backup' }))
    await user.click(await screen.findByRole('button', { name: 'Restore this backup' }))
    expect(await screen.findByRole('button', { name: /^Alpha/ })).toBeInTheDocument()
  }, 30_000)
  it.each([
    ['not JSON', 'hello'],
    ['the wrong kind of JSON', '{"a":1}'],
    ['a backup with a decimal in exponent form', JSON.stringify({ format: 'rupchain-portfolio-backup', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', assets: [{ id: 'a', name: 'A', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null }], events: [{ id: 'e', assetId: 'a', type: 'BUY', occurredAt: '2026-01-01T00:00:00.000Z', quantity: '1e3', consideration: '1', fee: null, basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null }], prices: [] })],
  ])('rejects %s without changing anything', async (_label, content) => {
    const { user } = await withOneToken()
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), new File([content], 'bad.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore this backup' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Alpha/ })).toBeInTheDocument()
  })
  it('erasing needs a second confirmation and then removes everything from this device', async () => {
    const { user, view } = await withOneToken()
    await user.click(screen.getByRole('button', { name: 'Erase everything on this device' }))
    await user.click(screen.getByRole('button', { name: 'Keep my data' }))
    expect(screen.getByRole('button', { name: /^Alpha/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Erase everything on this device' }))
    await user.click(screen.getByRole('button', { name: 'Yes, erase everything' }))
    expect(await screen.findByText('Everything on this device was erased.')).toBeInTheDocument()
    view.unmount()
    render(<GuestTracker />)
    await screen.findByText('No tracked tokens yet.')
    expect(within(document.body).queryByText('Alpha')).toBeNull()
  })
  it('no backup, restore or erase action touches the network', async () => {
    const { user } = await withOneToken()
    await user.click(screen.getByRole('button', { name: /Download plain backup/ }))
    await user.upload(screen.getByLabelText('Choose a backup file (.json)'), new File([await readBlob(blobs[0]!)], 'b.json'))
    await screen.findByText(/This backup has/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
