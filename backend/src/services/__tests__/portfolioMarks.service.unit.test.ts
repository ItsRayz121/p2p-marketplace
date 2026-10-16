import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ trades: vi.fn(), tokens: vi.fn(), audit: vi.fn() }))
vi.mock('../../lib/prisma', () => ({ db: { ctmTrade: { findMany: m.trades }, ctmToken: { findMany: m.tokens }, auditLog: { findMany: m.audit } } }))

import { platformMarksFor, mergeMarks, logosFor, resetPlatformMarkCache } from '../portfolioMarks.service'

beforeEach(() => {
  resetPlatformMarkCache()
  m.trades.mockReset(); m.tokens.mockReset(); m.audit.mockReset()
  m.audit.mockResolvedValue([])
})

const dec = (s: string) => ({ toFixed: () => s })
const at = (iso: string) => new Date(iso)

const trade = (o: Record<string, unknown> = {}) => ({
  id: 'x1', tradeRef: 'ref-x1', displayRef: null, buyerId: 'b', sellerId: 's', status: 'completed', settlementType: 'MANUAL',
  tokenId: 't1', tokenAmount: dec('200'), fiatAmount: dec('5000'), paymentCurrency: 'PKR', usdtAmount: null,
  completedAt: at('2026-10-15T00:00:00Z'), dispute: null, messages: [], proofs: [], ...o,
})
const LINKS = [{ id: 'a1', ctmTokenId: 't1' }, { id: 'a2', ctmTokenId: null }]

describe('platformMarksFor', () => {
  it('prices a linked token at the latest proven trade (PKR per token), labelled as a platform price', async () => {
    m.trades.mockResolvedValue([trade()])
    const out = await platformMarksFor(LINKS)
    expect(out).toEqual([{ assetId: 'a1', price: '25', quote: 'PKR', observedAt: at('2026-10-15T00:00:00Z'), source: 'platform' }])
  })

  it('skips an auto-completed, disputed or force-completed trade and uses the next proven one', async () => {
    m.audit.mockResolvedValue([{ metadata: { tradeRef: 'ref-forced' } }])
    m.trades.mockResolvedValue([
      trade({ id: 'auto', tradeRef: 'ref-auto', fiatAmount: dec('9000'), messages: [{ id: 'm' }] }),
      trade({ id: 'disp', tradeRef: 'ref-disp', fiatAmount: dec('9000'), dispute: { id: 'd' } }),
      trade({ id: 'forced', tradeRef: 'ref-forced', fiatAmount: dec('9000') }),
      trade({ id: 'good', tradeRef: 'ref-good', fiatAmount: dec('4000'), completedAt: at('2026-10-01T00:00:00Z') }),
    ])
    const out = await platformMarksFor(LINKS)
    expect(out).toEqual([{ assetId: 'a1', price: '20', quote: 'PKR', observedAt: at('2026-10-01T00:00:00Z'), source: 'platform' }])
  })

  it('an on-chain trade without a verified token transfer is not a price', async () => {
    m.trades.mockResolvedValue([trade({ settlementType: 'ON_CHAIN' })])
    expect(await platformMarksFor(LINKS)).toEqual([])
    resetPlatformMarkCache()
    m.trades.mockResolvedValue([trade({ settlementType: 'ON_CHAIN', proofs: [{ id: 'p' }] })])
    expect(await platformMarksFor(LINKS)).toHaveLength(1)
  })

  it('returns no price when no recent trade is proven (never falls back to an unproven one)', async () => {
    m.trades.mockResolvedValue([trade({ messages: [{ id: 'm' }] })])
    expect(await platformMarksFor(LINKS)).toEqual([])
  })

  it('skips tokens with unusable trade amounts and reads nothing when nothing is linked', async () => {
    m.trades.mockResolvedValue([trade({ tokenAmount: dec('0') })])
    expect(await platformMarksFor([{ id: 'a1', ctmTokenId: 't1' }])).toEqual([])
    m.trades.mockClear()
    expect(await platformMarksFor([{ id: 'a2', ctmTokenId: null }])).toEqual([])
    expect(m.trades).not.toHaveBeenCalled()
  })

  it('only reads (platform tables are never written) and caches briefly per token', async () => {
    m.trades.mockResolvedValue([trade()])
    await platformMarksFor(LINKS)
    await platformMarksFor(LINKS)
    expect(m.trades).toHaveBeenCalledTimes(1)
    const arg = m.trades.mock.calls[0]![0]
    expect(arg.where).toMatchObject({ tokenId: { in: ['t1'] }, status: 'completed' })
    expect(arg.take).toBeGreaterThan(0)
  })

  it('maps one platform price to every tracker asset that mirrors the token', async () => {
    m.trades.mockResolvedValue([trade()])
    const out = await platformMarksFor([{ id: 'a1', ctmTokenId: 't1' }, { id: 'a9', ctmTokenId: 't1' }])
    expect(out.map((r) => r.assetId).sort()).toEqual(['a1', 'a9'])
  })
})

describe('mergeMarks', () => {
  const row = (assetId: string, price: string, iso: string) => ({ assetId, price, quote: 'PKR' as const, observedAt: at(iso) })
  it('keeps the user\'s own price when it is newer, otherwise the platform price', () => {
    const merged = mergeMarks([row('a', '9', '2026-10-10T00:00:00Z'), row('b', '7', '2026-10-16T00:00:00Z')], [row('a', '10', '2026-10-15T00:00:00Z'), row('b', '8', '2026-10-15T00:00:00Z'), row('c', '1', '2026-10-01T00:00:00Z')])
    expect(Object.fromEntries(merged.map((r) => [r.assetId, r.price]))).toEqual({ a: '10', b: '7', c: '1' })
  })
})

describe('logosFor', () => {
  it('maps tracker assets to the logo of their platform token', async () => {
    m.tokens.mockResolvedValue([{ id: 't1', logoUrl: 'https://cdn.example/t1.png' }, { id: 't2', logoUrl: null }])
    const out = await logosFor([{ id: 'a1', ctmTokenId: 't1' }, { id: 'a2', ctmTokenId: 't2' }, { id: 'a3', ctmTokenId: null }])
    expect([...out]).toEqual([['a1', 'https://cdn.example/t1.png']])
  })
})
