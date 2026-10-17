import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  tradeFindMany: vi.fn(), tradeFindFirst: vi.fn(), auditFindMany: vi.fn(),
  evFindMany: vi.fn(), evCount: vi.fn(), evCreateMany: vi.fn(), evUpdateMany: vi.fn(), evCreate: vi.fn(), rate: vi.fn(),
  aFindMany: vi.fn(), aFindFirst: vi.fn(), aCount: vi.fn(), aCreate: vi.fn(),
}))

// Platform tables are READ-ONLY here: only read methods exist, so any write to a trade, the audit
// log, a wallet, a dispute, etc. throws and fails the test.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    ctmTrade: { findMany: m.tradeFindMany, findFirst: m.tradeFindFirst },
    auditLog: { findMany: m.auditFindMany },
    portfolioEvent: { findMany: m.evFindMany, count: m.evCount, createMany: m.evCreateMany, updateMany: m.evUpdateMany, create: m.evCreate },
    portfolioAsset: { findMany: m.aFindMany, findFirst: m.aFindFirst, count: m.aCount, create: m.aCreate },
  }, {
    get(t, p: string) {
      if (p in t) return (t as Record<string, unknown>)[p]
      throw new Error(`unexpected db access: ${p}`)
    },
  }),
}))

vi.mock('../platformFlags.service', () => ({ getStringConfig: m.rate }))

import { runCtmImport, listExcludedTrades, recordExcludedBatch, checkExcludedTradeRecordable, ensureLinkedAsset } from '../portfolioImport.service'

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
  m.evCreate.mockResolvedValue({ id: 'ev1' })
  m.rate.mockResolvedValue('280')
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

describe('Record all (batch)', () => {
  const disputed = (id: string, o: Record<string, unknown> = {}) => trade({ id, displayRef: `CTM-${id}`, status: 'dispute_resolved', ...o })
  const LIM = { maxAssets: 200, maxEvents: 5000 }

  it('lists how many trades could be recorded', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1'), disputed('t2'), trade({ id: 't3', status: 'awaiting_payment', completedAt: null })])
    const r = await listExcludedTrades('u1', { limit: 1, offset: 0 })
    expect(r.total).toBe(3)
    expect(r.recordable).toBe(2) // the unfinished one cannot be recorded
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).not.toHaveProperty('fxRate')
  })

  it('records every recordable trade with the amounts the platform holds, linked to the trade', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1'), disputed('t2'), trade({ id: 't3', status: 'awaiting_payment', completedAt: null })])
    const r = await recordExcludedBatch('u1', { all: true }, LIM)
    expect(r).toMatchObject({ recorded: 2, alreadyRecorded: 0, skipped: 0, failed: 0 })
    expect(m.evCreate).toHaveBeenCalledTimes(2)
    const data = m.evCreate.mock.calls[0]![0].data
    expect(data).toMatchObject({ userId: 'u1', type: 'BUY', quantity: '100', consideration: '125000', quote: 'PKR', fee: '0' })
    expect(['t1', 't2']).toContain(data.linkedTradeRef)
    expect(data.source).toBeUndefined() // a manual entry linked to the trade, not an imported one
  })

  it('never creates a second entry for a trade that was already recorded', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1')])
    m.evFindMany.mockImplementation(async (arg: { where: { linkedTradeRef?: unknown } }) => (arg.where.linkedTradeRef ? [{ linkedTradeRef: 't1' }] : []))
    const r = await recordExcludedBatch('u1', { tradeIds: ['t1'] }, LIM)
    expect(r).toMatchObject({ recorded: 0, alreadyRecorded: 1 })
    expect(m.evCreate).not.toHaveBeenCalled()
  })

  it('treats a lost race as already recorded, so a retry is safe', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1')])
    m.evCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }))
    const r = await recordExcludedBatch('u1', { all: true }, LIM)
    expect(r).toMatchObject({ recorded: 0, alreadyRecorded: 1, failed: 0 })
  })

  it('reports a partial failure per trade and keeps the rest', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1', { completedAt: new Date('2026-10-02T10:00:00Z') }), disputed('t2')])
    m.evCreate.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ id: 'ev' })
    const r = await recordExcludedBatch('u1', { all: true }, LIM)
    expect(r).toMatchObject({ recorded: 1, failed: 1 })
    expect(r.results.find((x) => x.outcome === 'failed')?.message).toBe('Could not be saved. Try again.')
  })

  it('stamps the rate a USDT-paid trade was done at, even for an old trade', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1', { paymentCurrency: 'USDT', usdtAmount: dec('500'), fiatAmount: dec('139000') })])
    await recordExcludedBatch('u1', { all: true }, LIM)
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ quote: 'USDT', consideration: '500', fxRate: '278', fxSource: 'platform' })
  })

  it('does not stamp today\'s rate on an old PKR trade', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1')])
    await recordExcludedBatch('u1', { all: true }, LIM)
    expect(m.evCreate.mock.calls[0]![0].data).toMatchObject({ fxRate: null, fxSource: null })
  })

  it('refuses ids that are not a left-out trade of the caller', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1')])
    const r = await recordExcludedBatch('u1', { tradeIds: ['someone-elses'] }, LIM)
    expect(r).toMatchObject({ recorded: 0, failed: 1 })
    expect(m.evCreate).not.toHaveBeenCalled()
  })

  it('stops at the entry limit instead of failing half-way silently', async () => {
    m.tradeFindMany.mockResolvedValue([disputed('t1'), disputed('t2')])
    m.evCount.mockResolvedValue(4999)
    const r = await recordExcludedBatch('u1', { all: true }, LIM)
    expect(r).toMatchObject({ recorded: 1, failed: 1 })
  })

  it('the single record check exposes the trade rate for USDT-paid trades', async () => {
    m.tradeFindFirst.mockResolvedValue(disputed('t1', { paymentCurrency: 'USDT', usdtAmount: dec('500'), fiatAmount: dec('139000') }))
    const c = await checkExcludedTradeRecordable('u1', 't1')
    expect(c).toMatchObject({ ok: true, fxRate: '278' })
  })
})
