import { describe, it, expect, vi } from 'vitest'

const m = vi.hoisted(() => ({ trades: vi.fn(), tokens: vi.fn() }))
vi.mock('../../lib/prisma', () => ({ db: { ctmTrade: { findMany: m.trades }, ctmToken: { findMany: m.tokens } } }))

import { platformMarksFor, mergeMarks, logosFor } from '../portfolioMarks.service'

const dec = (s: string) => ({ toFixed: () => s })
const at = (iso: string) => new Date(iso)

describe('platformMarksFor', () => {
  it('prices a linked token at the latest settled trade (PKR per token)', async () => {
    m.trades.mockResolvedValue([{ tokenId: 't1', tokenAmount: dec('200'), fiatAmount: dec('5000'), completedAt: at('2026-10-15T00:00:00Z') }])
    const out = await platformMarksFor([{ id: 'a1', ctmTokenId: 't1' }, { id: 'a2', ctmTokenId: null }])
    expect(out).toEqual([{ assetId: 'a1', price: '25', quote: 'PKR', observedAt: at('2026-10-15T00:00:00Z') }])
  })
  it('skips tokens with unusable trade amounts and reads nothing when nothing is linked', async () => {
    m.trades.mockResolvedValue([{ tokenId: 't1', tokenAmount: dec('0'), fiatAmount: dec('5000'), completedAt: at('2026-10-15T00:00:00Z') }])
    expect(await platformMarksFor([{ id: 'a1', ctmTokenId: 't1' }])).toEqual([])
    m.trades.mockClear()
    expect(await platformMarksFor([{ id: 'a2', ctmTokenId: null }])).toEqual([])
    expect(m.trades).not.toHaveBeenCalled()
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
