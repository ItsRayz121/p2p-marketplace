import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  tradeFindMany: vi.fn(),
  evFindMany: vi.fn(), evCount: vi.fn(), evCreateMany: vi.fn(), evUpdateMany: vi.fn(),
  aFindFirst: vi.fn(), aCount: vi.fn(), aCreate: vi.fn(),
}))

// Platform tables are READ-ONLY: only trade.findMany exists, so any write to a trade, wallet, order or dispute throws.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    trade: { findMany: m.tradeFindMany },
    portfolioEvent: { findMany: m.evFindMany, count: m.evCount, createMany: m.evCreateMany, updateMany: m.evUpdateMany },
    portfolioAsset: { findFirst: m.aFindFirst, count: m.aCount, create: m.aCreate },
  }, {
    get(t, p: string) {
      if (p in t) return (t as Record<string, unknown>)[p]
      throw new Error(`unexpected db access: ${p}`)
    },
  }),
}))

import { runUsdtImport } from '../portfolioUsdtImport.service'

const dec = (s: string) => new Prisma.Decimal(s)
const trade = (o: Record<string, unknown> = {}) => ({
  id: 't1', orderRef: 'RC-1', buyerId: 'u1', sellerId: 'u2', coin: 'USDT', status: 'crypto_released', amount: dec('100'), fiatAmount: dec('28100'),
  releasedAt: new Date('2026-10-01T10:00:00Z'), dispute: null, ...o,
})
const LIMITS = { dryRun: false, maxAssets: 200, maxEvents: 5000 }

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.tradeFindMany.mockResolvedValue([trade()])
  m.evFindMany.mockResolvedValue([])
  m.evCount.mockResolvedValue(0)
  m.aCount.mockResolvedValue(0)
  m.aFindFirst.mockResolvedValue(null)
  m.aCreate.mockResolvedValue({ id: 'usdtAsset' })
  m.evCreateMany.mockResolvedValue({ count: 1 })
  m.evUpdateMany.mockResolvedValue({ count: 0 })
})

describe('runUsdtImport', () => {
  it('creates the USDT holding and one read-only entry per released trade, stamped with the trade\'s own rate', async () => {
    const r = await runUsdtImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 1, hasImportedBefore: true })
    expect(m.aCreate.mock.calls[0]![0].data).toMatchObject({ userId: 'u1', ctmTokenId: 'p2p-usdt', name: 'Tether USDT', symbol: 'USDT' })
    const row = m.evCreateMany.mock.calls[0]![0].data[0]
    expect(row).toMatchObject({ assetId: 'usdtAsset', type: 'BUY', quantity: '100', consideration: '28100', quote: 'PKR', fxRate: '281', fxSource: 'platform', source: 'p2p', sourceRef: 't1' })
    expect(m.evCreateMany.mock.calls[0]![0].skipDuplicates).toBe(true)
  })
  it('a dry run writes nothing', async () => {
    const r = await runUsdtImport('u1', { ...LIMITS, dryRun: true })
    expect(r.created).toBe(1)
    expect(r.preview[0]).toMatchObject({ tradeRef: 'RC-1', tokenName: 'Tether USDT', type: 'BUY' })
    expect(m.aCreate).not.toHaveBeenCalled()
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
  it('the sell side of a trade is a SELL', async () => {
    const r = await runUsdtImport('u2', LIMITS)
    expect(r.created).toBe(1)
    expect(m.evCreateMany.mock.calls[0]![0].data[0]).toMatchObject({ type: 'SELL', userId: 'u2' })
  })
  it('disputed, pending and cancelled trades create nothing', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ status: 'disputed' }), trade({ id: 't2', status: 'crypto_sent', releasedAt: null }), trade({ id: 't3', dispute: { id: 'd' } })])
    const r = await runUsdtImport('u1', LIMITS)
    expect(r.created).toBe(0)
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
  it('an open dispute keeps the trade out; once resolved it is added automatically', async () => {
    const resolvedAt = new Date('2026-10-05T12:00:00Z')
    m.tradeFindMany.mockResolvedValue([trade({ status: 'disputed', releasedAt: null, dispute: { id: 'd', status: 'under_review', resolutionType: null, resolvedAt: null } })])
    expect((await runUsdtImport('u1', LIMITS)).created).toBe(0)
    // Settled by the parties: the trade completed on its own, dated when it was released.
    m.tradeFindMany.mockResolvedValue([trade({ dispute: { id: 'd', status: 'resolved', resolutionType: 'settled_by_parties', resolvedAt } })])
    expect((await runUsdtImport('u1', LIMITS)).created).toBe(1)
    // Admin ruled for the buyer: the trade ended as resolved; it is added, dated at the ruling.
    m.evCreateMany.mockClear()
    m.tradeFindMany.mockResolvedValue([trade({ status: 'dispute_resolved', releasedAt: null, dispute: { id: 'd', status: 'resolved', resolutionType: 'buyer_wins', resolvedAt } })])
    expect((await runUsdtImport('u1', LIMITS)).created).toBe(1)
    expect(m.evCreateMany.mock.calls[0]![0].data[0]).toMatchObject({ type: 'BUY', occurredAt: resolvedAt, quantity: '100', consideration: '28100' })
  })
  it('a ruling for the seller means nothing was exchanged, and a split cannot be added automatically', async () => {
    const resolvedAt = new Date('2026-10-05T12:00:00Z')
    m.tradeFindMany.mockResolvedValue([trade({ status: 'dispute_resolved', releasedAt: null, dispute: { id: 'd', status: 'resolved', resolutionType: 'seller_wins', resolvedAt } })])
    expect((await runUsdtImport('u1', LIMITS)).created).toBe(0)
    m.tradeFindMany.mockResolvedValue([trade({ status: 'dispute_resolved', releasedAt: null, dispute: { id: 'd', status: 'resolved', resolutionType: 'split', resolvedAt } })])
    expect((await runUsdtImport('u1', LIMITS)).created).toBe(0)
  })
  it('records no fee on a trade: the marketplace charges none', async () => {
    await runUsdtImport('u1', LIMITS)
    expect(m.evCreateMany.mock.calls[0]![0].data[0].fee).toBe('0')
  })
  it('is idempotent: a trade already imported is not added again', async () => {
    m.evFindMany.mockResolvedValue([{ id: 'e1', sourceRef: 't1', voidedAt: null }])
    const r = await runUsdtImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 0, alreadyImported: 1 })
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
  it('voids an imported entry only in the user\'s own portfolio table when its trade stops qualifying', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ status: 'disputed' })])
    m.evFindMany.mockResolvedValue([{ id: 'e1', sourceRef: 't1', voidedAt: null }])
    const r = await runUsdtImport('u1', LIMITS)
    expect(r.voided).toBe(1)
    expect(m.evUpdateMany.mock.calls[0]![0]).toMatchObject({ where: { id: { in: ['e1'] }, userId: 'u1', source: 'p2p' }, data: { voidReason: 'disputed' } })
  })
  it('respects the per-user entry limit instead of failing half-way', async () => {
    m.evCount.mockResolvedValue(5000)
    const r = await runUsdtImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 0, skippedForLimit: 1 })
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
})
