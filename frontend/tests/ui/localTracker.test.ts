import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openStore } from '@/lib/portfolio/local/idb'
import { createLocalTracker, MAX_LOCAL_ASSETS, type LocalTracker } from '@/lib/portfolio/local/localApi'
import { parseBackup } from '@/lib/portfolio/exportFile'

let n = 0
const dbName = () => `test-db-${++n}`
const past = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

async function fresh(): Promise<{ t: LocalTracker; name: string }> {
  const name = dbName()
  return { t: await createLocalTracker(await openStore(name)), name }
}

beforeEach(() => { (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory() })
afterEach(() => vi.restoreAllMocks())

describe('storage', () => {
  it('keeps data between visits (a new tracker on the same store sees it)', async () => {
    const name = dbName()
    const a = await createLocalTracker(await openStore(name))
    await a.api.addAsset({ name: 'Meta Earth' })
    const b = await createLocalTracker(await openStore(name))
    expect((await b.api.listAssets()).map((x) => x.name)).toEqual(['Meta Earth'])
    expect(b.persistent).toBe(true)
  })
  it('without IndexedDB it still works but says the data is not saved', async () => {
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    const t = await createLocalTracker(await openStore('x'))
    expect(t.persistent).toBe(false)
    await t.api.addAsset({ name: 'A' })
    expect(t.counts().assets).toBe(1)
    ;(globalThis as { indexedDB?: unknown }).indexedDB = saved
  })
  it('unreadable stored data is set aside, not destroyed, and an empty tracker starts', async () => {
    const name = dbName()
    const store = await openStore(name)
    await store.set('data', { assets: 'garbage', events: 5 })
    const t = await createLocalTracker(store)
    expect(t.recovered).toBe(true)
    expect(t.counts()).toEqual({ assets: 0, events: 0 })
    expect(await store.get('data-corrupt')).toEqual({ assets: 'garbage', events: 5 })
  })
  it('clearAll removes everything stored in this browser', async () => {
    const name = dbName()
    const store = await openStore(name)
    const t = await createLocalTracker(store)
    await t.api.addAsset({ name: 'A' })
    await t.clearAll()
    expect(await store.get('data')).toBeUndefined()
    expect((await (await createLocalTracker(await openStore(name))).api.listAssets()).length).toBe(0)
  })
  it('never makes a network request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A', sourceUrl: 'https://example.com' })
    await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(2), quantity: '1', consideration: '10' })
    await t.api.setPrice(a.id, '12')
    await t.api.summary('PKR')
    await t.api.performance({ currency: 'PKR' })
    await t.api.exportAll()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('tokens', () => {
  it('same name, symbol and link never merge', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha', symbol: 'ALP', sourceUrl: 'https://alpha.example' })
    const b = await t.api.addAsset({ name: 'Alpha', symbol: 'ALP', sourceUrl: 'https://alpha.example' })
    expect(a.id).not.toBe(b.id)
    expect((await t.api.listAssets()).length).toBe(2)
  })
  it('applies the same validation as the server', async () => {
    const { t } = await fresh()
    await expect(t.api.addAsset({ name: '' })).rejects.toThrow(/Enter the token name/)
    await expect(t.api.addAsset({ name: 'X', sourceUrl: 'javascript:alert(1)' })).rejects.toThrow(/http/)
    await expect(t.api.addAsset({ name: 'X', contractAddress: '0xabc' })).rejects.toThrow(/network/)
  })
  it('caps the number of tokens', async () => {
    const { t } = await fresh()
    for (let i = 0; i < MAX_LOCAL_ASSETS; i++) await t.api.addAsset({ name: `T${i}` })
    await expect(t.api.addAsset({ name: 'one more' })).rejects.toThrow(/up to/)
  })
  it('editing details never changes any entry or result', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Old' })
    await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(5), quantity: '10', consideration: '1000' })
    await t.api.setPrice(a.id, '150')
    const before = JSON.stringify((await t.api.summary('PKR')).summary)
    await t.api.updateAsset(a.id, { name: 'Brand new name', symbol: 'ZZZ' })
    expect(JSON.stringify((await t.api.summary('PKR')).summary)).toBe(before)
  })
  it('delete only without records; archive keeps history; archived tokens are read-only', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A' })
    await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(2), quantity: '1', consideration: '5' })
    await expect(t.api.deleteAsset(a.id)).rejects.toThrow(/Archive it instead/)
    await t.api.archiveAsset(a.id)
    expect((await t.api.listAssets(false)).length).toBe(0)
    expect((await t.api.listAssets(true)).length).toBe(1)
    await expect(t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(1), quantity: '1', consideration: '5' })).rejects.toThrow(/archived/)
    await expect(t.api.setPrice(a.id, '5')).rejects.toThrow(/archived/)
    expect((await t.api.listEvents(a.id)).length).toBe(1) // history still readable
    const b = await t.api.addAsset({ name: 'B' })
    await t.api.deleteAsset(b.id)
    expect((await t.api.listAssets()).map((x) => x.name)).toEqual(['A'])
  })
})

describe('entries', () => {
  it('rejects what the server rejects', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A' })
    const bad = [
      { type: 'BUY', occurredAt: past(1), quantity: '0', consideration: '1' },
      { type: 'BUY', occurredAt: past(1), quantity: '1e5', consideration: '1' },
      { type: 'BUY', occurredAt: new Date(Date.now() + 3_600_000).toISOString(), quantity: '1', consideration: '1' },
      { type: 'BUY', occurredAt: past(1), quantity: '1' },
      { type: 'OPENING', occurredAt: past(1), quantity: '1', basis: '0' },
    ]
    for (const e of bad) await expect(t.api.addEvent(a.id, e as never)).rejects.toThrow()
    expect((await t.api.listEvents(a.id)).length).toBe(0)
  })
  it('a retried save with the same request id records once', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A' })
    const input = { type: 'BUY' as const, occurredAt: past(2), quantity: '1', consideration: '5', clientRequestId: 'req-12345678' }
    const first = await t.api.addEvent(a.id, input)
    const second = await t.api.addEvent(a.id, input)
    expect(second.id).toBe(first.id)
    expect((await t.api.listEvents(a.id)).length).toBe(1)
    const b = await t.api.addAsset({ name: 'B' })
    await expect(t.api.addEvent(b.id, input)).rejects.toThrow(/different token/)
  })
  it('removing an entry frees its request id', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A' })
    const input = { type: 'BUY' as const, occurredAt: past(2), quantity: '1', consideration: '5', clientRequestId: 'req-12345678' }
    const e = await t.api.addEvent(a.id, input)
    await t.api.deleteEvent(a.id, e.id)
    const again = await t.api.addEvent(a.id, input)
    expect(again.id).not.toBe(e.id)
  })
})

describe('results are produced by the same engine as the server', () => {
  async function fixture() {
    const { t } = await fresh()
    const add = async (name: string) => (await t.api.addAsset({ name })).id
    const [mec, usdt, sda, rubi] = [await add('MEC'), await add('USDT'), await add('SDA'), await add('RUBI')]
    await t.api.addEvent(mec, { type: 'BUY', occurredAt: past(20), quantity: '100', consideration: '100000', fee: '1000' })
    await t.api.addEvent(mec, { type: 'SELL', occurredAt: past(10), quantity: '40', consideration: '52000', fee: '400' })
    await t.api.addEvent(usdt, { type: 'BUY', occurredAt: past(20), quantity: '400', consideration: '111200' })
    await t.api.addEvent(sda, { type: 'BUY', occurredAt: past(20), quantity: '1000', consideration: '10000' })
    await t.api.addEvent(rubi, { type: 'BUY', occurredAt: past(20), quantity: '1000', consideration: '12000' })
    for (const [id, p] of [[mec, '1200'], [usdt, '280'], [sda, '8'], [rubi, '15']] as const) await t.api.setPrice(id, p)
    return { t, mec }
  }

  it('the spec aggregate: 207,000 / 193,800 / 13,200 / 11,200 / 24,400', async () => {
    const { t } = await fixture()
    const s = (await t.api.summary('PKR')).summary
    expect(s).toMatchObject({ pricedValue: '207000', knownRemainingBasis: '193800', knownUnrealized: '13200', knownRealized: '11200', knownTotalPnl: '24400', partial: false })
  })
  it('the first fixture: realized 11,200, remaining 60 units at 60,600, unrealized 11,400', async () => {
    const { t, mec } = await fixture()
    const p = (await t.api.summary('PKR')).summary.positions.find((x) => x.assetId === mec)!
    expect(p).toMatchObject({ quantity: '60', knownRemainingBasis: '60600', realizedKnown: '11200', value: '72000', unrealized: '11400' })
  })
  it('unknown stays unknown: an unpriced token with no cost is flagged and never valued at zero', async () => {
    const { t } = await fixture()
    const x = await t.api.addAsset({ name: 'Mystery' })
    await t.api.addEvent(x.id, { type: 'OPENING', occurredAt: past(3), quantity: '500' })
    const s = (await t.api.summary('PKR')).summary
    expect(s.partial).toBe(true)
    expect(s.unpricedAssets).toEqual([x.id])
    expect(s.unknownBasisAssets).toEqual([x.id])
    expect(s.pricedValue).toBe('207000')
  })
  it('results over time use the same calculation', async () => {
    const { t } = await fixture()
    const r = await t.api.performance({ currency: 'PKR' })
    expect(r.points.length).toBeGreaterThan(2)
    expect(r.period.realized).toBe('11200')
    expect(r.points.at(-1)).toMatchObject({ realized: '11200' })
  })
  it('an entry dated now gets the rate the user typed in; an old entry gets none', async () => {
    const { t } = await fresh()
    await t.setUsdtPkr('281.5')
    const a = await t.api.addAsset({ name: 'A' })
    const recent = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), quantity: '1', consideration: '10', quote: 'USDT' })
    const old = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(30), quantity: '1', consideration: '10', quote: 'USDT' })
    expect(recent).toMatchObject({ fxRate: '281.5', fxSource: 'manual' })
    expect(old).toMatchObject({ fxRate: null, fxSource: null })
    const s = await t.api.summary('PKR')
    expect(s.fxUnavailableAssets).toEqual([a.id]) // the old USDT entry has no rate, so the token cannot be shown in PKR
  })
  it('a bad current rate is refused', async () => {
    const { t } = await fresh()
    for (const r of ['0', '-3', 'abc', '1e3']) await expect(t.setUsdtPkr(r)).rejects.toThrow()
    await t.setUsdtPkr(null)
    expect(t.getUsdtPkr()).toBeNull()
  })
  it('voided entries (from an account backup) are shown but never counted', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A' })
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(2), quantity: '1', consideration: '10' })
    const backup = parseBackup(t.backupText())
    if (!backup.ok) throw new Error('backup')
    backup.data.events[0] = { ...backup.data.events[0]!, source: 'ctm', voided: true, voidReason: 'disputed' }
    await t.replaceAll(backup.data)
    expect((await t.api.listEvents(a.id))[0]).toMatchObject({ id: e.id, voided: true })
    expect((await t.api.summary('PKR')).summary.positions).toEqual([])
  })
})

describe('backup', () => {
  it('produces a file the app can read back, and restoring replaces the data exactly', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'A', symbol: 'AA' })
    await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(3), quantity: '2.5', consideration: '125.75', fee: '1' })
    await t.api.setPrice(a.id, '60')
    const parsed = parseBackup(t.backupText())
    expect(parsed.ok).toBe(true)
    const { t: other } = await fresh()
    if (parsed.ok) await other.replaceAll(parsed.data)
    expect(JSON.stringify((await other.api.summary('PKR')).summary)).toBe(JSON.stringify((await t.api.summary('PKR')).summary))
    expect((await other.api.listAssets()).map((x) => x.name)).toEqual(['A'])
  })
})

describe('correcting an entry in the local tracker', () => {
  it('changes the entry in place, keeps its identity, and recalculates', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha' })
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(10), quantity: '100', consideration: '1000', fee: '0' })
    const fixed = await t.api.updateEvent(a.id, e.id, { type: 'BUY', occurredAt: e.occurredAt, quantity: '100', consideration: '1500', fee: '0' })
    expect(fixed.id).toBe(e.id)
    expect((await t.api.listEvents(a.id)).map((x) => x.consideration)).toEqual(['1500'])
    const s = await t.api.summary('PKR')
    expect(s.summary.positions[0]!.knownRemainingBasis).toBe('1500')
  })
  it('applies the same validation as a new entry and fails on an unknown entry', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha' })
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(10), quantity: '100', consideration: '1000' })
    await expect(t.api.updateEvent(a.id, e.id, { type: 'BUY', occurredAt: past(10), quantity: '0', consideration: '1' })).rejects.toThrow(/greater than zero/)
    await expect(t.api.updateEvent(a.id, 'nope', { type: 'BUY', occurredAt: past(10), quantity: '1', consideration: '1' })).rejects.toThrow(/not found/i)
    expect((await t.api.listEvents(a.id))[0]!.quantity).toBe('100')
  })
  it('keeps the stored exchange rate when the date and currency are unchanged, and drops it when they change', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha' })
    const when = past(10)
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: when, quantity: '10', consideration: '5', quote: 'USDT', fxRate: '280' })
    const kept = await t.api.updateEvent(a.id, e.id, { type: 'BUY', occurredAt: when, quantity: '10', consideration: '6', quote: 'USDT' })
    expect(kept.fxRate).toBe('280')
    const moved = await t.api.updateEvent(a.id, e.id, { type: 'BUY', occurredAt: past(40), quantity: '10', consideration: '6', quote: 'USDT' })
    expect(moved.fxRate).toBeNull()
  })
  it('a corrected backup still round-trips', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha' })
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(10), quantity: '100', consideration: '1000' })
    await t.api.updateEvent(a.id, e.id, { type: 'BUY', occurredAt: e.occurredAt, quantity: '100', consideration: '1100' })
    const out = parseBackup(t.backupText())
    expect(out.ok).toBe(true)
  })
})

describe('all transactions in the local tracker', () => {
  it('lists across tokens newest first, with search, filters and paging', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha', symbol: 'ALP' })
    const b = await t.api.addAsset({ name: 'Beta' })
    await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(30), quantity: '10', consideration: '100', note: 'first lot' })
    await t.api.addEvent(a.id, { type: 'SELL', occurredAt: past(10), quantity: '4', consideration: '60' })
    await t.api.addEvent(b.id, { type: 'BUY', occurredAt: past(20), quantity: '1', consideration: '5' })
    const all = await t.api.listAllEvents!({ limit: 25, offset: 0 })
    expect(all.total).toBe(3)
    expect(all.items.map((e) => [e.assetName, e.type])).toEqual([['Alpha', 'SELL'], ['Beta', 'BUY'], ['Alpha', 'BUY']])
    expect((await t.api.listAllEvents!({ limit: 25, offset: 0, q: 'alp' })).total).toBe(2) // symbol
    expect((await t.api.listAllEvents!({ limit: 25, offset: 0, q: 'FIRST' })).items.map((e) => e.note)).toEqual(['first lot'])
    expect((await t.api.listAllEvents!({ limit: 25, offset: 0, type: 'SELL' })).total).toBe(1)
    expect((await t.api.listAllEvents!({ limit: 25, offset: 0, assetId: b.id })).total).toBe(1)
    expect((await t.api.listAllEvents!({ limit: 25, offset: 0, source: 'ctm' })).total).toBe(0)
    expect((await t.api.listAllEvents!({ limit: 2, offset: 2 })).items).toHaveLength(1)
  })
  it('a price basis chosen on an entry is kept, survives a backup round-trip, and is refused for an opening holding', async () => {
    const { t } = await fresh()
    const a = await t.api.addAsset({ name: 'Alpha' })
    const e = await t.api.addEvent(a.id, { type: 'BUY', occurredAt: past(1), quantity: '1', consideration: '5', priceBasis: 'own' })
    expect(e.priceBasis).toBe('own')
    const parsed = parseBackup(t.backupText())
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.data.events[0]!.priceBasis).toBe('own')
    await expect(t.api.addEvent(a.id, { type: 'OPENING', occurredAt: past(1), quantity: '1', priceBasis: 'own' })).rejects.toThrow(/no price/)
  })
})
