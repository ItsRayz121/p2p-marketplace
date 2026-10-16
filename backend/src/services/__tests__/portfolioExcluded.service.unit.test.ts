import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  tradeFindMany: vi.fn(), tradeFindFirst: vi.fn(), auditFindMany: vi.fn(),
  evFindMany: vi.fn(), evCount: vi.fn(), evCreateMany: vi.fn(), evUpdateMany: vi.fn(),
  aFindMany: vi.fn(), aFindFirst: vi.fn(), aCount: vi.fn(), aCreate: vi.fn(),
}))

// Platform tables are READ-ONLY here: only read methods exist, so any write to a trade, the audit
// log, a wallet, a dispute, etc. throws and fails the test.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    ctmTrade: { findMany: m.tradeFindMany, findFirst: m.tradeFindFirst },
    auditLog: { findMany: m.auditFindMany },
    portfolioEvent: { findMany: m.evFindMany, count: m.evCount, createMany: m.evCreateMany, updateMany: m.evUpdateMany },
    portfolioAsset: { findMany: m.aFindMany, findFirst: m.aFindFirst, count: m.aCount, create: m.aCreate },
  }, {
    get(t, p: string) {
      if (p in t) return (t as Record<string, unknown>)[p]
      throw new Error(`unexpected db access: ${p}`)
    },
  }),
}))

import { runCtmImport, listExcludedTrades, checkExcludedTradeRecordable, ensureLinkedAsset } from '../portfolioImport.service'

const dec = (s: string) => new Prisma.Decimal(s)
const token = { id: 'tok1', name: 'Meta Earth', symbol: 'MEC', network: 'BEP20', contractAddress: '0xabc', officialWebsite: null }
const trade = (o: Record<string, unknown> = {}) => ({
  id: 't1', tradeRef: 'ref-1', displayRef: 'CTM-1', buyerId: 'u1', sellerId: 'u2', status: 'completed', settlementType: 'MANUAL',
  completedAt: new Date('2026-10-01T10:00:00Z'), createdAt: new Date('2026-09-30T10:00:00Z'), tokenId: 'tok1', tokenAmount: dec('100'), fiatAmount: dec('125000'),
  paymentCurrency: 'PKR', usdtAmount: null, token, dispute: null, messages: [], proofs: [], ...o,
})
const LIMITS = { dryRun: false, maxAssets: 200, maxEvents: 5000 }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.tradeFindMany.mockResolvedValue([trade()])
  m.auditFindMany.mockResolvedValue([])
  m.evFindMany.mockResolvedValue([])
  m.evCount.mockResolvedValue(0)
  m.aFindMany.mockResolvedValue([])
  m.aFindFirst.mockResolvedValue(null)
  m.aCount.mockResolvedValue(0)
  m.aCreate.mockResolvedValue({ id: 'asset1' })
  m.evCreateMany.mockResolvedValue({ count: 1 })
})

describe('a trade the user already recorded by hand', () => {
  it('is not imported a second time, and is reported as recorded by the user', async () => {
    m.evFindMany.mockImplementation(async (arg: { where: { linkedTradeRef?: unknown } }) =>
      arg.where.linkedTradeRef ? [{ linkedTradeRef: 't1' }] : [])
    const r = await runCtmImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 0, recordedManually: 1 })
    expect(m.evCreateMany).not.toHaveBeenCalled()
    const handQuery = m.evFindMany.mock.calls.map(([a]) => a).find((a) => a.where.linkedTradeRef)
    expect(handQuery.where).toMatchObject({ userId: 'u1', source: 'manual' })
  })
})

describe('listExcludedTrades (read-only review list)', () => {
  const excluded = (o: Record<string, unknown> = {}) => trade({ dispute: { id: 'd' }, ...o })

  it('lists only trades that were left out, newest first, with the reason and the user side', async () => {
    m.tradeFindMany.mockResolvedValue([
      trade({ id: 'ok' }),
      excluded({ id: 'd1', tradeRef: 'ref-d1', displayRef: 'CTM-D1', completedAt: new Date('2026-10-02T00:00:00Z') }),
      excluded({ id: 'a1', tradeRef: 'ref-a1', displayRef: 'CTM-A1', dispute: null, messages: [{ id: 'm' }], completedAt: new Date('2026-10-05T00:00:00Z') }),
      trade({ id: 'p1', tradeRef: 'ref-p1', displayRef: 'CTM-P1', status: 'buyer_confirming', completedAt: null, createdAt: new Date('2026-10-06T00:00:00Z') }),
    ])
    const r = await listExcludedTrades('u1', { limit: 25, offset: 0 })
    expect(r.total).toBe(3)
    expect(r.items.map((i) => [i.tradeRef, i.reason, i.canRecord])).toEqual([
      ['CTM-P1', 'in_progress', false],
      ['CTM-A1', 'auto_completed', true],
      ['CTM-D1', 'disputed', true],
    ])
    expect(r.items[1]).toMatchObject({ side: 'BUY', quantity: '100', consideration: '125000', quote: 'PKR', tokenName: 'Meta Earth', recorded: false })
  })

  it('marks a trade the user already recorded, and pages the list', async () => {
    m.tradeFindMany.mockResolvedValue([excluded({ id: 'd1' }), excluded({ id: 'd2', tradeRef: 'r2', completedAt: new Date('2026-10-02T00:00:00Z') })])
    m.evFindMany.mockResolvedValue([{ linkedTradeRef: 'd1' }])
    const first = await listExcludedTrades('u1', { limit: 1, offset: 0 })
    expect(first.total).toBe(2)
    expect(first.items).toHaveLength(1)
    const all = await listExcludedTrades('u1', { limit: 5, offset: 0 })
    expect(all.items.find((i) => i.tradeId === 'd1')!.recorded).toBe(true)
    expect(all.items.find((i) => i.tradeId === 'd2')!.recorded).toBe(false)
    expect((await listExcludedTrades('u1', { limit: 5, offset: 5 })).items).toEqual([])
  })

  it('an administrator force-completed trade is listed as such', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ id: 'f', tradeRef: 'ref-f' })])
    m.auditFindMany.mockResolvedValue([{ metadata: { tradeRef: 'ref-f' } }])
    const r = await listExcludedTrades('u1', { limit: 25, offset: 0 })
    expect(r.items.map((i) => i.reason)).toEqual(['admin_completed'])
  })

  it('writes nothing', async () => {
    m.tradeFindMany.mockResolvedValue([excluded()])
    await listExcludedTrades('u1', { limit: 25, offset: 0 })
    for (const w of [m.evCreateMany, m.evUpdateMany, m.aCreate]) expect(w).not.toHaveBeenCalled()
  })
})

describe('checkExcludedTradeRecordable', () => {
  const found = (o: Record<string, unknown> = {}) => trade({ dispute: { id: 'd' }, ...o })

  it('allows a finished trade that was left out, from the user side', async () => {
    m.tradeFindFirst.mockResolvedValue(found())
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: true, side: 'BUY', tradeId: 't1' })
    m.tradeFindFirst.mockResolvedValue(found({ buyerId: 'u2', sellerId: 'u1' }))
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: true, side: 'SELL' })
  })
  it('only looks at trades the caller is a party to', async () => {
    m.tradeFindFirst.mockResolvedValue(null)
    expect(await checkExcludedTradeRecordable('u1', 'theirs')).toMatchObject({ ok: false, status: 404 })
    expect(m.tradeFindFirst.mock.calls[0]![0].where).toEqual({ id: 'theirs', OR: [{ buyerId: 'u1' }, { sellerId: 'u1' }] })
  })
  it('refuses a trade that already counts automatically, one that is unfinished, and one that never happened', async () => {
    m.tradeFindFirst.mockResolvedValue(trade())
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/automatically/) })
    m.tradeFindFirst.mockResolvedValue(trade({ status: 'buyer_confirming', completedAt: null }))
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/not finished/) })
    m.tradeFindFirst.mockResolvedValue(trade({ status: 'cancelled', completedAt: null }))
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/Nothing was exchanged/) })
  })
  it('recognises an administrator force-completion from the audit log', async () => {
    m.tradeFindFirst.mockResolvedValue(trade())
    m.auditFindMany.mockResolvedValue([{ metadata: { tradeRef: 'ref-1' } }])
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: true })
  })
  it('refuses a trade whose amounts cannot be used', async () => {
    m.tradeFindFirst.mockResolvedValue(found({ tokenAmount: dec('0') }))
    expect(await checkExcludedTradeRecordable('u1', 't1')).toMatchObject({ ok: false, status: 409 })
  })
})

describe('ensureLinkedAsset', () => {
  it('reuses the existing linked token', async () => {
    m.aFindFirst.mockResolvedValue({ id: 'asset9' })
    expect(await ensureLinkedAsset('u1', token, { maxAssets: 200 })).toBe('asset9')
    expect(m.aCreate).not.toHaveBeenCalled()
  })
  it('creates it once for the caller only, and respects the token limit', async () => {
    m.aFindFirst.mockResolvedValue(null)
    m.aCount.mockResolvedValue(3)
    expect(await ensureLinkedAsset('u1', token, { maxAssets: 200 })).toBe('asset1')
    expect(m.aCreate.mock.calls[0]![0].data).toMatchObject({ userId: 'u1', ctmTokenId: 'tok1', name: 'Meta Earth' })
    m.aCreate.mockClear()
    m.aCount.mockResolvedValue(200)
    expect(await ensureLinkedAsset('u1', token, { maxAssets: 200 })).toBeNull()
    expect(m.aCreate).not.toHaveBeenCalled()
  })
})
