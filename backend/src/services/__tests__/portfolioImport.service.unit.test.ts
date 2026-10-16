import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const m = vi.hoisted(() => ({
  tradeFindMany: vi.fn(), auditFindMany: vi.fn(),
  evFindMany: vi.fn(), evCount: vi.fn(), evCreateMany: vi.fn(), evUpdateMany: vi.fn(),
  aFindMany: vi.fn(), aFindFirst: vi.fn(), aCount: vi.fn(), aCreate: vi.fn(),
}))

// Platform tables are READ-ONLY here: only the read methods exist, so any write attempt to a trade,
// the audit log, a wallet, a payout, a dispute, etc. throws and fails the test.
vi.mock('../../lib/prisma', () => ({
  db: new Proxy({
    ctmTrade: { findMany: m.tradeFindMany },
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

import { runCtmImport } from '../portfolioImport.service'

const dec = (s: string) => new Prisma.Decimal(s)
const token = { id: 'tok1', name: 'Meta Earth', symbol: 'MEC', network: 'BEP20', contractAddress: '0xabc', officialWebsite: 'https://metaearth.example' }
const trade = (o: Record<string, unknown> = {}) => ({
  id: 't1', tradeRef: 'ref-1', displayRef: 'CTM-1', buyerId: 'u1', sellerId: 'u2', status: 'completed', settlementType: 'MANUAL',
  completedAt: new Date('2026-10-01T10:00:00Z'), tokenId: 'tok1', tokenAmount: dec('100'), fiatAmount: dec('125000'),
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

describe('reading trades', () => {
  it('only reads the caller\'s own trades and skips cancelled/expired ones', async () => {
    await runCtmImport('u1', LIMITS)
    const arg = m.tradeFindMany.mock.calls[0]![0]
    expect(arg.where).toEqual({ OR: [{ buyerId: 'u1' }, { sellerId: 'u1' }], status: { notIn: ['cancelled', 'expired'] } })
    expect(arg.take).toBeGreaterThan(0)
  })
  it('reads administrator force-completions from the audit log by trade reference (read only)', async () => {
    await runCtmImport('u1', LIMITS)
    const arg = m.auditFindMany.mock.calls[0]![0]
    expect(arg.where.action).toBe('CTM_ADMIN_FORCE_RELEASE')
    expect(arg.where.OR).toEqual([{ metadata: { path: ['tradeRef'], equals: 'ref-1' } }])
  })
})

describe('importing', () => {
  it('creates a linked token and one read-only BUY entry for a settled trade', async () => {
    const r = await runCtmImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 1, restored: 0, voided: 0, dryRun: false, hasImportedBefore: true })
    expect(m.aCreate.mock.calls[0]![0].data).toMatchObject({
      userId: 'u1', ctmTokenId: 'tok1', name: 'Meta Earth', symbol: 'MEC', network: 'BEP20', contractAddress: '0xabc', sourceUrl: 'https://metaearth.example/',
    })
    const arg = m.evCreateMany.mock.calls[0]![0]
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toEqual([expect.objectContaining({
      userId: 'u1', assetId: 'asset1', type: 'BUY', quantity: '100', consideration: '125000', fee: '0', quote: 'PKR',
      source: 'ctm', sourceRef: 't1', note: 'Imported from RupChain trade CTM-1',
    })])
  })
  it('the seller\'s tracker gets a SELL', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ buyerId: 'u2', sellerId: 'u1' })])
    await runCtmImport('u1', LIMITS)
    expect(m.evCreateMany.mock.calls[0]![0].data[0].type).toBe('SELL')
  })
  it('reuses an existing linked token instead of creating another', async () => {
    m.aFindMany.mockResolvedValue([{ id: 'existing', ctmTokenId: 'tok1' }])
    await runCtmImport('u1', LIMITS)
    expect(m.aCreate).not.toHaveBeenCalled()
    expect(m.evCreateMany.mock.calls[0]![0].data[0].assetId).toBe('existing')
  })
  it('two trades of the same token share one tracker token', async () => {
    m.tradeFindMany.mockResolvedValue([trade(), trade({ id: 't2', tradeRef: 'ref-2', displayRef: 'CTM-2' })])
    await runCtmImport('u1', LIMITS)
    expect(m.aCreate).toHaveBeenCalledTimes(1)
    expect(m.evCreateMany.mock.calls[0]![0].data).toHaveLength(2)
  })
  it('a USDT-paid trade is stored in USDT with the rate implied by the trade', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ paymentCurrency: 'USDT', usdtAmount: dec('446.42857143') })])
    await runCtmImport('u1', LIMITS)
    expect(m.evCreateMany.mock.calls[0]![0].data[0]).toMatchObject({ quote: 'USDT', consideration: '446.42857143', fxRate: '280', fxSource: 'platform' })
  })
  it('never writes anything for trades that are disputed, admin-completed, auto-completed, unverified or in progress', async () => {
    m.tradeFindMany.mockResolvedValue([
      trade({ id: 'd', dispute: { id: 'x' } }),
      trade({ id: 'a', tradeRef: 'ref-a', messages: [{ id: 'm' }] }),
      trade({ id: 'f', tradeRef: 'ref-f' }),
      trade({ id: 'o', settlementType: 'ON_CHAIN' }),
      trade({ id: 'p', status: 'buyer_confirming', completedAt: null }),
    ])
    m.auditFindMany.mockResolvedValue([{ metadata: { tradeRef: 'ref-f' } }])
    const r = await runCtmImport('u1', LIMITS)
    expect(r.created).toBe(0)
    expect(r.attention.map((x) => x.reason).sort()).toEqual(['admin_completed', 'auto_completed', 'disputed', 'in_progress', 'unverified_transfer'])
    expect(m.evCreateMany).not.toHaveBeenCalled()
    expect(m.aCreate).not.toHaveBeenCalled()
  })
  it('an on-chain trade with a verified token-transfer proof is imported', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ settlementType: 'ON_CHAIN', proofs: [{ id: 'p' }] })])
    expect((await runCtmImport('u1', LIMITS)).created).toBe(1)
  })
  it('only the proof query for VERIFIED tx hashes and system auto-complete messages is used', async () => {
    await runCtmImport('u1', LIMITS)
    const sel = m.tradeFindMany.mock.calls[0]![0].select
    expect(sel.proofs.where).toEqual({ proofType: 'txhash', txVerificationStatus: 'verified' })
    expect(sel.messages.where).toEqual({ isSystem: true, message: { startsWith: 'Trade auto-completed' } })
  })
})

describe('dry run, idempotency and reversals', () => {
  it('a dry run reports and previews but writes nothing', async () => {
    const r = await runCtmImport('u1', { ...LIMITS, dryRun: true })
    expect(r).toMatchObject({ dryRun: true, created: 1 })
    expect(r.preview).toEqual([expect.objectContaining({ tradeRef: 'CTM-1', tokenName: 'Meta Earth', type: 'BUY', quantity: '100', quote: 'PKR' })])
    expect(m.aCreate).not.toHaveBeenCalled()
    expect(m.evCreateMany).not.toHaveBeenCalled()
    expect(m.evUpdateMany).not.toHaveBeenCalled()
  })
  it('running again after an import creates nothing', async () => {
    m.evFindMany.mockResolvedValue([{ id: 'e1', sourceRef: 't1', voidedAt: null }])
    m.aFindMany.mockResolvedValue([{ id: 'asset1', ctmTokenId: 'tok1' }])
    const r = await runCtmImport('u1', LIMITS)
    expect(r).toMatchObject({ created: 0, alreadyImported: 1, voided: 0, hasImportedBefore: true })
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
  it('an imported trade that later gets a dispute is voided (kept, excluded), scoped to the caller\'s imported entries', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ dispute: { id: 'x' } })])
    m.evFindMany.mockResolvedValue([{ id: 'e1', sourceRef: 't1', voidedAt: null }])
    const r = await runCtmImport('u1', LIMITS)
    expect(r.voided).toBe(1)
    const arg = m.evUpdateMany.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: { in: ['e1'] }, userId: 'u1', source: 'ctm' })
    expect(arg.data.voidReason).toBe('disputed')
    expect(arg.data.voidedAt).toBeInstanceOf(Date)
  })
  it('a voided entry is restored when its trade qualifies again', async () => {
    m.evFindMany.mockResolvedValue([{ id: 'e1', sourceRef: 't1', voidedAt: new Date() }])
    m.aFindMany.mockResolvedValue([{ id: 'asset1', ctmTokenId: 'tok1' }])
    const r = await runCtmImport('u1', LIMITS)
    expect(r.restored).toBe(1)
    expect(m.evUpdateMany.mock.calls[0]![0]).toMatchObject({ where: { id: { in: ['e1'] }, userId: 'u1', source: 'ctm' }, data: { voidedAt: null, voidReason: null } })
    expect(m.evCreateMany).not.toHaveBeenCalled()
  })
})

describe('limits and resilience', () => {
  it('stops at the per-user entry limit and reports what it skipped', async () => {
    m.evCount.mockResolvedValue(4999)
    m.tradeFindMany.mockResolvedValue([trade(), trade({ id: 't2', tradeRef: 'ref-2' })])
    const r = await runCtmImport('u1', LIMITS)
    expect(r.created).toBe(1)
    expect(r.skippedForLimit).toBe(1)
  })
  it('stops creating new tokens at the per-user token limit', async () => {
    m.aCount.mockResolvedValue(200)
    const r = await runCtmImport('u1', LIMITS)
    expect(r.created).toBe(0)
    expect(r.skippedForLimit).toBe(1)
    expect(m.aCreate).not.toHaveBeenCalled()
  })
  it('if a parallel import already created the linked token, uses it', async () => {
    m.aCreate.mockRejectedValue(new Error('Unique constraint failed'))
    m.aFindFirst.mockResolvedValue({ id: 'raced' })
    await runCtmImport('u1', LIMITS)
    expect(m.evCreateMany.mock.calls[0]![0].data[0].assetId).toBe('raced')
  })
  it('platform token text that fails our checks falls back to a clean name only', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ token: { ...token, symbol: '<script>', contractAddress: 'not valid!', officialWebsite: 'javascript:alert(1)' } })])
    await runCtmImport('u1', LIMITS)
    expect(m.aCreate.mock.calls[0]![0].data).toMatchObject({ name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null })
  })
  it('a platform website that is a valid link is kept; a hostile one is dropped', async () => {
    m.tradeFindMany.mockResolvedValue([trade({ token: { ...token, officialWebsite: 'https://u:p@evil.example' } })])
    await runCtmImport('u1', LIMITS)
    expect(m.aCreate.mock.calls[0]![0].data.sourceUrl).toBeNull()
  })
})
