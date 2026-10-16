import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

// An in-memory stand-in for ONLY the four portfolio tables. Any other table (wallet, orders, trades...)
// throws if touched, which is the point: a restore can only ever write the caller's portfolio records.
const h = await vi.hoisted(async () => {
  const { Prisma: P } = await import('@prisma/client')
  type Row = Record<string, unknown>
  const tables: Record<string, Row[]> = { portfolioAsset: [], portfolioEvent: [], portfolioPriceObservation: [], portfolioEventRevision: [] }
  let seq = 0
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => matches(row, w))
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as { in?: unknown[]; not?: unknown }
        if ('in' in o) return o.in!.includes(row[k])
        if ('not' in o) return row[k] !== o.not
      }
      return row[k] === v
    })
  }
  const model = (name: string) => ({
    findMany: async ({ where }: { where?: Row }) => tables[name]!.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    count: async ({ where }: { where?: Row } = {}) => tables[name]!.filter((r) => matches(r, where)).length,
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let n = 0
      for (const d of data) {
        const row = { ...d } as Row
        if (name === 'portfolioPriceObservation') row.price = new P.Decimal(String(row.price))
        if (name === 'portfolioEvent' && row.clientRequestId && tables[name]!.some((r) => r.userId === row.userId && r.clientRequestId === row.clientRequestId)) {
          if (skipDuplicates) continue
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        if (name === 'portfolioAsset') row.ctmTokenId ??= null // the real column defaults to null
        row.createdAt ??= new Date(1700000000000 + seq++)
        tables[name]!.push(row); n += 1
      }
      return { count: n }
    },
  })
  const models = { portfolioAsset: model('portfolioAsset'), portfolioEvent: model('portfolioEvent'), portfolioPriceObservation: model('portfolioPriceObservation'), portfolioEventRevision: model('portfolioEventRevision') }
  const locks: string[] = []
  const api = {
    ...models,
    $executeRaw: async (strings: TemplateStringsArray, ...vals: unknown[]) => { locks.push(`${strings.join('?')}|${vals.join(',')}`); return 1 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const dec = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]))
      try { return await fn(guarded) } catch (e) { for (const k of Object.keys(tables)) tables[k] = dec[k]!; throw e }
    },
  }
  const guarded = new Proxy(api, { get(t, p: string) { if (p in t) return (t as Record<string, unknown>)[p]; throw new Error(`unexpected db access: ${p}`) } })
  return { tables, guarded, locks, check: vi.fn(), ensure: vi.fn() }
})

vi.mock('../../lib/prisma', () => ({ db: h.guarded }))
vi.mock('../portfolioImport.service', () => ({ checkExcludedTradeRecordable: h.check, ensureLinkedAsset: h.ensure }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test' } }))

import { restorePortfolioBackup, type RestoreLimits } from '../portfolioRestore.service'
import { AppError } from '../../lib/errors'

const LIMITS: RestoreLimits = { maxAssets: 200, maxEvents: 5000, maxRevisionsPerEvent: 50, maxRevisionsPerUser: 20000 }
const past = '2026-09-01T10:00:00.000Z'

const asset = (o: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Alpha', symbol: 'ALP', sourceUrl: null, network: null, contractAddress: null,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null, linkedToRupChainToken: false, ...o,
})
const entry = (o: Record<string, unknown> = {}) => ({
  id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: past, quantity: '10', consideration: '1000', fee: '5', basis: null, zeroCost: false,
  quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null,
  priceBasis: 'own', editedAt: null, linkedTradeRef: null, ...o,
})
const file = (o: Record<string, unknown> = {}) => ({
  format: 'rupchain-portfolio-backup', version: 2, exportedAt: past,
  assets: [asset()], events: [entry()], prices: [{ assetId: 'a1', price: '120', quote: 'PKR', observedAt: past }], revisions: [], ...o,
})
const restore = (f: unknown, userId = 'u1', limits = LIMITS) => restorePortfolioBackup(userId, f, limits)
const rowsOf = (t: string, userId = 'u1') => h.tables[t]!.filter((r) => r.userId === userId)

beforeEach(() => {
  for (const k of Object.keys(h.tables)) h.tables[k] = []
  h.check.mockReset(); h.ensure.mockReset(); h.locks.length = 0
})

describe('restorePortfolioBackup', () => {
  it('brings back tokens, entries, prices and correction history into an empty account', async () => {
    const r = await restore(file({
      assets: [asset({ archivedAt: '2026-08-01T00:00:00.000Z' })],
      events: [entry({ editedAt: '2026-09-02T00:00:00.000Z', note: 'fixed' })],
      revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: '2026-09-02T00:00:00.000Z', before: { type: 'BUY', quantity: '9' } }],
    }))
    expect(r).toMatchObject({ assets: { created: 1 }, entries: { restored: 1 }, prices: { restored: 1 }, history: { restored: 1 } })
    const [a] = rowsOf('portfolioAsset'); const [e] = rowsOf('portfolioEvent'); const [v] = rowsOf('portfolioEventRevision')
    expect(a).toMatchObject({ name: 'Alpha', symbol: 'ALP' })
    expect((a!.archivedAt as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(e).toMatchObject({ assetId: a!.id, quantity: '10', note: 'fixed', priceBasis: 'own', type: 'BUY' })
    expect((e!.editedAt as Date).toISOString()).toBe('2026-09-02T00:00:00.000Z')
    // History points at the NEW id of the restored entry, not the id from the file.
    expect(e!.id).not.toBe('e1')
    expect(v).toMatchObject({ eventId: e!.id, assetId: a!.id, action: 'edit', before: { type: 'BUY', quantity: '9' } })
  })

  it('takes a per-account lock first, so two restores at once cannot both create the same token', async () => {
    await restore(file(), 'u1')
    expect(h.locks).toHaveLength(1)
    expect(h.locks[0]).toContain('pg_advisory_xact_lock')
    expect(h.locks[0]).toContain('portfolio-restore:u1')
  })

  it('keeps the source label of a saved price', async () => {
    await restore(file({ prices: [{ assetId: 'a1', price: '120', quote: 'PKR', observedAt: past, source: 'p2p' }] }))
    expect(rowsOf('portfolioPriceObservation')[0]).toMatchObject({ source: 'p2p' })
  })

  it('is safe to run twice: the second run adds nothing', async () => {
    const f = file({ revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: past, before: { type: 'BUY' } }] })
    await restore(f)
    const second = await restore(f)
    expect(second).toMatchObject({ assets: { created: 0, alreadyThere: 1 }, entries: { restored: 0, alreadyThere: 1 }, prices: { restored: 0, alreadyThere: 1 }, history: { restored: 0 } })
    expect(h.tables.portfolioAsset).toHaveLength(1)
    expect(h.tables.portfolioEvent).toHaveLength(1)
    expect(h.tables.portfolioPriceObservation).toHaveLength(1)
    expect(h.tables.portfolioEventRevision).toHaveLength(1)
  })

  it('adds nothing when the account still has the original data (same ids)', async () => {
    h.tables.portfolioAsset!.push({ id: 'a1', userId: 'u1', name: 'Alpha', symbol: 'ALP', network: null, contractAddress: null, createdAt: new Date('2026-01-01'), ctmTokenId: null })
    h.tables.portfolioEvent!.push({ id: 'e1', userId: 'u1', assetId: 'a1', clientRequestId: null, linkedTradeRef: null })
    const r = await restore(file({ prices: [] }))
    expect(r).toMatchObject({ assets: { created: 0, alreadyThere: 1 }, entries: { restored: 0, alreadyThere: 1 } })
    expect(h.tables.portfolioEvent).toHaveLength(1)
  })

  it('writes only for the signed-in user and never reuses ids from the file', async () => {
    h.tables.portfolioAsset!.push({ id: 'a1', userId: 'someone-else', name: 'Alpha', symbol: 'ALP', network: null, contractAddress: null, createdAt: new Date('2026-01-01'), ctmTokenId: null })
    await restore(file(), 'u1')
    expect(rowsOf('portfolioAsset', 'u1')).toHaveLength(1)
    expect(rowsOf('portfolioAsset', 'u1')[0]!.id).not.toBe('a1')
    expect(h.tables.portfolioAsset!.find((r) => r.userId === 'someone-else')).toBeDefined()
    expect(h.tables.portfolioAsset).toHaveLength(2)
  })

  it('keeps the history of a removed entry under its original id, and skips history of entries it did not restore', async () => {
    const r = await restore(file({
      revisions: [
        { eventId: 'gone', assetId: 'a1', action: 'delete', createdAt: past, before: { type: 'SELL', quantity: '1' } },
        { eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: past, before: { type: 'BUY' } },
      ],
    }))
    expect(r.history.restored).toBe(2)
    expect(rowsOf('portfolioEventRevision').map((v) => v.eventId).sort()).toContain('gone')
    // A later run restores no history for the entry that was already there.
    const again = await restore(file({ revisions: [{ eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: '2026-09-09T00:00:00.000Z', before: { type: 'BUY' } }] }))
    expect(again.history.restored).toBe(0)
  })

  it('does not add a "removed" record next to an entry that may still exist on a token the account already had', async () => {
    h.tables.portfolioAsset!.push({ id: 'mine1', userId: 'u1', name: 'Alpha', symbol: 'ALP', network: null, contractAddress: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), ctmTokenId: null })
    const r = await restore(file({
      events: [], prices: [],
      revisions: [{ eventId: 'gone', assetId: 'a1', action: 'delete', createdAt: past, before: { type: 'SELL' } }],
    }))
    expect(r.assets).toMatchObject({ created: 0, alreadyThere: 1 })
    expect(r.history.restored).toBe(0)
    expect(h.tables.portfolioEventRevision).toHaveLength(0)
  })

  it('tells the user when the backup is missing the oldest corrections', async () => {
    const r = await restore(file({ revisionsTruncated: true }))
    expect(r.notes.join(' ')).toMatch(/does not include the oldest corrections/)
  })

  it('does not copy entries read from RupChain trades, and says so', async () => {
    const r = await restore(file({ events: [entry(), entry({ id: 'e2', source: 'ctm', voided: true, voidReason: 'disputed' })] }))
    expect(r.entries.restored).toBe(1)
    expect(h.tables.portfolioEvent).toHaveLength(1)
    expect(r.notes.join(' ')).toMatch(/RupChain trades/)
  })

  it('opening holdings keep their cost; sells and buys keep their fee; the saved exchange rate is kept as it was', async () => {
    await restore(file({ events: [
      entry({ id: 'o1', type: 'OPENING', consideration: null, fee: null, basis: '500', priceBasis: null }),
      entry({ id: 's1', type: 'SELL', quantity: '1', consideration: '200', fee: null, quote: 'USDT', fxRate: '280.5', fxSource: 'manual' }),
    ] }))
    const open = rowsOf('portfolioEvent').find((r) => r.type === 'OPENING')!
    const sell = rowsOf('portfolioEvent').find((r) => r.type === 'SELL')!
    expect(open).toMatchObject({ basis: '500', consideration: null, fee: null, priceBasis: null })
    expect(sell).toMatchObject({ fee: '0', quote: 'USDT', fxRate: '280.5', fxSource: 'manual' })
  })

  describe('entries recorded for a RupChain trade', () => {
    const linked = file({ assets: [asset(), asset({ id: 'l1', name: 'Linked', linkedToRupChainToken: true })], events: [entry({ id: 'e9', assetId: 'l1', linkedTradeRef: 'trade1' })], prices: [] })

    it('are restored onto the linked token when the platform still agrees the trade is yours to record', async () => {
      h.check.mockResolvedValue({ ok: true, side: 'BUY', token: { id: 'tok' }, tradeId: 'trade1' })
      h.ensure.mockResolvedValue('linkedAsset1')
      const r = await restore(linked)
      expect(h.check).toHaveBeenCalledWith('u1', 'trade1')
      expect(r.entries.restored).toBe(1)
      expect(rowsOf('portfolioEvent')[0]).toMatchObject({ assetId: 'linkedAsset1', linkedTradeRef: 'trade1' })
    })
    it('are left out, with a note, when the trade no longer qualifies, so nothing is counted twice', async () => {
      h.check.mockResolvedValue({ ok: false, status: 409, message: 'This trade is added to your portfolio automatically.' })
      const r = await restore(linked)
      expect(r.entries.restored).toBe(0)
      expect(h.tables.portfolioEvent).toHaveLength(0)
      expect(r.notes.join(' ')).toMatch(/counting the trade twice/)
    })
    it('are left out when you were on the other side of the trade', async () => {
      h.check.mockResolvedValue({ ok: true, side: 'SELL', token: { id: 'tok' }, tradeId: 'trade1' })
      h.ensure.mockResolvedValue('linkedAsset1')
      expect((await restore(linked)).entries.restored).toBe(0)
    })
    it('are not recorded a second time for a trade you already recorded', async () => {
      h.check.mockResolvedValue({ ok: true, side: 'BUY', token: { id: 'tok' }, tradeId: 'trade1' })
      h.ensure.mockResolvedValue('linkedAsset1')
      h.tables.portfolioEvent!.push({ id: 'old', userId: 'u1', assetId: 'linkedAsset1', clientRequestId: null, linkedTradeRef: 'trade1' })
      const r = await restore(linked)
      expect(r.entries).toMatchObject({ restored: 0, alreadyThere: 1 })
      expect(h.tables.portfolioEvent).toHaveLength(1)
    })
  })

  it('leaves out other entries on RupChain-linked tokens, with a note', async () => {
    const r = await restore(file({ assets: [asset({ id: 'l1', linkedToRupChainToken: true })], events: [entry({ assetId: 'l1' })], prices: [] }))
    expect(r.entries).toMatchObject({ restored: 0, notRestored: 1 })
    expect(r.notes.join(' ')).toMatch(/could not be placed on a token/)
  })

  describe('rejects a bad file whole, changing nothing', () => {
    const rejects = async (f: unknown, msg: RegExp) => {
      await expect(restore(f)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(msg) })
      for (const t of Object.values(h.tables)) expect(t).toHaveLength(0)
    }
    it('not a backup', () => rejects({ hello: 1 }, /not a valid RupChain portfolio backup/))
    it('unknown extra field', () => rejects({ ...file(), extra: true }, /not a valid/))
    it('malformed amount', () => rejects(file({ events: [entry({ quantity: '1e3' })] }), /not a valid/))
    it('entry on a token that is not in the file', () => rejects(file({ events: [entry({ assetId: 'zzz' })] }), /not in the file/))
    it('the same entry twice', () => rejects(file({ events: [entry(), entry()] }), /same entry twice/))
    it('the same token twice', () => rejects(file({ assets: [asset(), asset()] }), /same token twice/))
    it('a date in the future', () => rejects(file({ events: [entry({ occurredAt: '2999-01-01T00:00:00.000Z' })] }), /Entry 1 cannot be restored/))
    it('a buy with no amount', () => rejects(file({ events: [entry({ consideration: null })] }), /Entry 1 cannot be restored/))
    it('an unsafe token (link with a script scheme)', () => rejects(file({ assets: [asset({ sourceUrl: 'javascript:alert(1)' })] }), /invalid or unsafe/))
    it('a price for a token that is not in the file', () => rejects(file({ prices: [{ assetId: 'zzz', price: '1', quote: 'PKR', observedAt: past }] }), /not in the file/))
  })

  it('goes over the entry limit: everything is rolled back, including tokens already written', async () => {
    await expect(restore(file(), 'u1', { ...LIMITS, maxEvents: 0 })).rejects.toMatchObject({ code: 'PORTFOLIO_EVENT_LIMIT' })
    for (const t of Object.values(h.tables)) expect(t).toHaveLength(0)
  })
  it('goes over the token limit: nothing is written', async () => {
    await expect(restore(file(), 'u1', { ...LIMITS, maxAssets: 0 })).rejects.toBeInstanceOf(AppError)
    for (const t of Object.values(h.tables)) expect(t).toHaveLength(0)
  })
  it('caps history per entry instead of failing the restore', async () => {
    const revs = [1, 2, 3].map((i) => ({ eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: `2026-09-0${i}T00:00:00.000Z`, before: { type: 'BUY' } }))
    const r = await restore(file({ revisions: revs }), 'u1', { ...LIMITS, maxRevisionsPerEvent: 2 })
    expect(r.history).toMatchObject({ restored: 2, notRestored: 1 })
    expect(r.notes.join(' ')).toMatch(/history limit/)
  })
  it('accepts an older (version 1) backup, which has no history to bring back', async () => {
    const { revisions, ...v1 } = file({ version: 1 }) as Record<string, unknown>; void revisions
    const r = await restore(v1)
    expect(r.entries.restored).toBe(1)
    expect(r.history.restored).toBe(0)
  })
  it('never reads or writes a table outside the four portfolio tables', async () => {
    h.check.mockResolvedValue({ ok: true, side: 'BUY', token: { id: 'tok' }, tradeId: 'trade1' })
    h.ensure.mockResolvedValue('x')
    // The guarded db throws on any other table (wallet, orders...), so a full run passing proves it.
    await expect(restore(file({ events: [entry(), entry({ id: 'e2', assetId: 'l1', linkedTradeRef: 't2' })], assets: [asset(), asset({ id: 'l1', linkedToRupChainToken: true })] }))).resolves.toBeDefined()
  })
  it('the Prisma Decimal helper used by the fake is real', () => { expect(new Prisma.Decimal('1.50').toFixed()).toBe('1.5') })
})
