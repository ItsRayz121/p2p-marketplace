import { describe, it, expect } from 'vitest'
import type { EventRow } from '../summaryBuilder'
import { buildSummary } from '../summaryBuilder'
import { computePosition } from '../fifo'
import {
  computeBaseline, findAliasGroups, openingMarketTotal, openingMarketValue, openingRows, readLots, walletContext,
  type IdentityInput,
} from '../period'
import { valueHoldings, snapshotValueIn, minuteBucket } from '../snapshot'

let n = 0
const ev = (o: Partial<EventRow> & Pick<EventRow, 'assetId' | 'type' | 'quantity'>): EventRow => ({
  id: `e${++n}`, occurredAt: new Date('2026-09-01T00:00:00Z'), consideration: null, fee: null, basis: null, zeroCost: false, quote: 'PKR', fxRate: null, ...o,
})
const buy = (assetId: string, quantity: string, consideration: string, at: string, extra: Partial<EventRow> = {}) =>
  ev({ assetId, type: 'BUY', quantity, consideration, fee: '0', occurredAt: new Date(at), ...extra })
const sell = (assetId: string, quantity: string, consideration: string, at: string, extra: Partial<EventRow> = {}) =>
  ev({ assetId, type: 'SELL', quantity, consideration, fee: '0', occurredAt: new Date(at), ...extra })

const START = new Date('2026-10-18T07:00:00Z')

describe('baseline from the user\'s own records (FIFO, deterministic fixture)', () => {
  // Method in this repository is FIFO (not weighted average): buy 10 @ 100, buy 10 @ 120, sell 5 @ 130, no fees.
  const rows = [
    buy('A', '10', '1000', '2026-09-01T00:00:00Z'),
    buy('A', '10', '1200', '2026-09-02T00:00:00Z'),
    sell('A', '5', '650', '2026-09-03T00:00:00Z'),
  ]
  it('the sale realizes proceeds minus the cost of the OLDEST units; the rest keeps its own cost', () => {
    const p = computePosition('A', rows.map((r, i) => ({ id: r.id, assetId: 'A', type: r.type, at: r.occurredAt.toISOString(), seq: i, quantity: r.quantity, consideration: r.consideration ?? undefined, fee: r.fee ?? undefined })))
    expect(p.realizedKnown).toBe('150') // 650 - 5 * 100
    expect(p.quantity).toBe('15')
    expect(p.knownRemainingBasis).toBe('1700') // 5 @ 100 + 10 @ 120
  })
  it('carries the remaining lots with their ACTUAL cost into the baseline, in both currencies', () => {
    const [b] = computeBaseline(rows)
    expect(b!.quantity).toBe('15')
    expect(b!.lots.map((l) => [l.qty, l.basisPkr])).toEqual([['5', '500'], ['10', '1200']])
    // No exchange rate was recorded, so the cost in USDT is unknown (not zero, not converted at today's rate).
    expect(b!.lots.every((l) => l.basisUsdt === null)).toBe(true)
    expect(b!.basisUnknown).toBe(false)
  })
  it('a later sale realizes against the baseline cost, never against the market price on the cutover day', () => {
    const base = computeBaseline(rows)
    const holdings = base.map((b) => ({ id: 'h1', assetId: b.assetId, lots: b.lots }))
    const opening = openingRows(holdings, 'PKR', START)
    const after = sell('A', '5', '1000', '2026-10-20T00:00:00Z')
    const s = buildSummary({ events: [...opening, after], prices: [{ assetId: 'A', price: '999', quote: 'PKR', observedAt: START }], currency: 'PKR', platformRate: null })
    const pos = s.summary.positions[0]!
    expect(pos.realizedKnown).toBe('500') // 1000 - 5 * 100 (actual), not 1000 - 5 * 999
    expect(pos.quantity).toBe('10')
    expect(pos.knownRemainingBasis).toBe('1200')
    expect(pos.unrealized).toBe(String(10 * 999 - 1200))
  })
})

describe('what the baseline refuses to invent', () => {
  it('units sold beyond the records are recorded as a discrepancy, and no units appear', () => {
    const [b] = computeBaseline([buy('M', '1', '100', '2026-09-01T00:00:00Z'), sell('M', '3', '400', '2026-09-02T00:00:00Z')])
    expect(b!.quantity).toBe('0')
    expect(b!.lots).toEqual([])
    expect(b!.oversoldQuantity).toBe('2')
    expect(b!.oversoldSales).toBe(1)
  })
  it('a token that was bought and fully sold leaves nothing to carry', () => {
    expect(computeBaseline([buy('Z', '4', '40', '2026-09-01T00:00:00Z'), sell('Z', '4', '50', '2026-09-02T00:00:00Z')])).toEqual([])
  })
  it('an unknown cost stays unknown (null), never zero', () => {
    const [b] = computeBaseline([ev({ assetId: 'U', type: 'OPENING', quantity: '7', basis: null, occurredAt: new Date('2026-09-01T00:00:00Z') })])
    expect(b!.lots[0]!.basisPkr).toBeNull()
    expect(b!.basisUnknown).toBe(true)
    const rows = openingRows([{ id: 'h', assetId: 'U', lots: b!.lots }], 'PKR', START)
    expect(rows[0]!.basis).toBeNull()
    const s = buildSummary({ events: rows, prices: [{ assetId: 'U', price: '3', quote: 'PKR', observedAt: START }], currency: 'PKR', platformRate: null })
    expect(s.summary.positions[0]!.unrealized).toBeNull()
    expect(s.summary.positions[0]!.value).toBe('21')
  })
  it('a genuine zero cost (declared) stays a zero cost', () => {
    const [b] = computeBaseline([ev({ assetId: 'G', type: 'OPENING', quantity: '2', basis: '0', zeroCost: true })])
    expect(b!.lots[0]!.basisPkr).toBe('0')
    expect(openingRows([{ id: 'h', assetId: 'G', lots: b!.lots }], 'PKR', START)[0]).toMatchObject({ basis: '0', zeroCost: true })
  })
  it('a corrupt stored lot is skipped instead of breaking the portfolio', () => {
    expect(readLots([{ qty: '1' }, null, 'x', { eventId: 'e', acquiredAt: 'a', qty: '2', basisPkr: '5' }])).toEqual([{ eventId: 'e', acquiredAt: 'a', qty: '2', basisPkr: '5', basisUsdt: null }])
    expect(readLots('nope')).toEqual([])
  })
})

describe('display currency changes the presentation, never the holdings', () => {
  const rows = [
    buy('T', '10', '2780', '2026-09-01T00:00:00Z', { fxRate: '278' }),
    buy('T', '4', '1200', '2026-09-02T00:00:00Z', { quote: 'USDT', fxRate: '280' }),
  ]
  it('quantities are identical in PKR and USDT', () => {
    const [b] = computeBaseline(rows)
    expect(b!.quantity).toBe('14')
    const pkr = openingRows([{ id: 'h', assetId: 'T', lots: b!.lots }], 'PKR', START)
    const usdt = openingRows([{ id: 'h', assetId: 'T', lots: b!.lots }], 'USDT', START)
    expect(pkr.map((r) => r.quantity)).toEqual(usdt.map((r) => r.quantity))
    const a = buildSummary({ events: pkr, prices: [{ assetId: 'T', price: '300', quote: 'PKR', observedAt: START }], currency: 'PKR', platformRate: '280' })
    const c = buildSummary({ events: usdt, prices: [{ assetId: 'T', price: '300', quote: 'PKR', observedAt: START }], currency: 'USDT', platformRate: '280' })
    expect(a.summary.positions[0]!.quantity).toBe(c.summary.positions[0]!.quantity)
    // Value converts at the platform rate: same economics.
    expect(Number(a.summary.positions[0]!.value) / 280).toBeCloseTo(Number(c.summary.positions[0]!.value), 6)
  })
})

describe('opening MARKET value is separate from cost', () => {
  const quoted = { price: '300', quote: 'PKR' as const }
  it('is quantity x the cutover-day quote, converted at the cutover rate', () => {
    expect(openingMarketValue('10', quoted, 'PKR', null)).toBe('3000')
    expect(openingMarketValue('10', quoted, 'USDT', '300')).toBe('10')
    expect(openingMarketValue('10', { price: '1', quote: 'USDT' }, 'PKR', '280')).toBe('2800')
  })
  it('is unknown (null) with no quote or no rate, never zero', () => {
    expect(openingMarketValue('10', { price: null, quote: null }, 'PKR', null)).toBeNull()
    expect(openingMarketValue('10', quoted, 'USDT', null)).toBeNull()
  })
  it('a total is only given when every held token had a quote', () => {
    const ok = [{ quantity: '2', market: quoted }, { quantity: '1', market: { price: '50', quote: 'PKR' as const } }]
    expect(openingMarketTotal(ok, 'PKR', null)).toBe('650')
    expect(openingMarketTotal([...ok, { quantity: '1', market: { price: null, quote: null } }], 'PKR', null)).toBeNull()
    expect(openingMarketTotal([{ quantity: '0', market: { price: null, quote: null } }], 'PKR', null)).toBe('0')
  })
})

describe('asset identity: USD and USDT are different assets', () => {
  const asset = (id: string, o: Partial<IdentityInput> = {}): IdentityInput => ({ id, name: id, symbol: null, network: null, contractAddress: null, ctmTokenId: null, ...o })
  it('groups tokens that share a network and contract (any letter case), never by similar names', () => {
    const g = findAliasGroups([
      asset('a', { network: 'BSC', contractAddress: '0xAbC' }), asset('b', { network: 'bsc', contractAddress: '0xabc' }),
      asset('usd', { name: 'USD', symbol: 'USD' }), asset('usdt', { name: 'USDT', symbol: 'USDT', ctmTokenId: 'p2p-usdt' }),
    ])
    expect(g).toEqual([{ key: 'chain:bsc:0xabc', assetIds: ['a', 'b'] }])
  })
  it('the per-user USDT holding is only ever matched with itself', () => {
    expect(findAliasGroups([asset('x', { ctmTokenId: 'p2p-usdt' }), asset('y', { name: 'USD cash' })])).toEqual([])
    expect(findAliasGroups([asset('x', { ctmTokenId: 'p2p-usdt' }), asset('y', { ctmTokenId: 'p2p-usdt' })])).toHaveLength(1)
  })
})

describe('wallet figures are context: reserved is part of owned, not added to it', () => {
  it('available = owned - reserved', () => {
    expect(walletContext([{ coin: 'USDT', network: 'TRC20', balance: '100', lockedBalance: '30' }])).toEqual([{ coin: 'USDT', network: 'TRC20', owned: '100', reserved: '30', available: '70' }])
  })
})

describe('valuing the holdings', () => {
  const now = new Date('2026-10-18T10:00:00Z')
  const marks = new Map([['A', { price: '10', quote: 'PKR' as const, observedAt: now }], ['U', { price: '1', quote: 'USDT' as const, observedAt: new Date('2026-09-01T00:00:00Z') }]])
  it('sums priced holdings and converts USDT quotes at the platform rate', () => {
    const v = valueHoldings([{ assetId: 'A', quantity: '3' }, { assetId: 'U', quantity: '2' }], marks, '280', now)
    expect(v).toEqual({ valuePkr: '590', heldCount: 2, pricedCount: 2, staleCount: 1 })
  })
  it('one unpriced token makes the whole total unknown, not a partial sum and not zero', () => {
    const v = valueHoldings([{ assetId: 'A', quantity: '3' }, { assetId: 'X', quantity: '1' }], marks, '280', now)
    expect(v.valuePkr).toBeNull()
    expect(v).toMatchObject({ heldCount: 2, pricedCount: 1 })
  })
  it('a USDT quote with no rate cannot be converted, so it is unknown', () => {
    expect(valueHoldings([{ assetId: 'U', quantity: '2' }], marks, null, now).valuePkr).toBeNull()
  })
  it('an empty portfolio is a genuine zero', () => {
    expect(valueHoldings([], marks, null, now)).toEqual({ valuePkr: '0', heldCount: 0, pricedCount: 0, staleCount: 0 })
    expect(valueHoldings([{ assetId: 'A', quantity: '0' }], marks, null, now).valuePkr).toBe('0')
  })
  it('shows a stored PKR value in either currency from the same moment', () => {
    expect(snapshotValueIn('2800', '280', 'USDT')).toBe('10')
    expect(snapshotValueIn('2800', '280', 'PKR')).toBe('2800')
    expect(snapshotValueIn('2800', null, 'USDT')).toBeNull()
    expect(snapshotValueIn(null, '280', 'PKR')).toBeNull()
  })
  it('buckets to the minute', () => {
    expect(minuteBucket(new Date('2026-10-18T10:00:59.999Z')).toISOString()).toBe('2026-10-18T10:00:00.000Z')
  })
})
