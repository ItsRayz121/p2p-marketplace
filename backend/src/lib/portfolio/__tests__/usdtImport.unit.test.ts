import { describe, it, expect } from 'vitest'
import { classifyUsdtTrade, toUsdtEventSpec, planUsdtImport, impliedUsdtRate, type UsdtTradeFacts, type UsdtEventSpec } from '../usdtImport'
import { buildSummary, type EventRow, type PriceRow } from '../summaryBuilder'
import { mergeImportReports } from '../mergeImportReports'

const ME = 'me'
const trade = (o: Partial<UsdtTradeFacts> = {}): UsdtTradeFacts => ({
  id: 't1', orderRef: 'RC-1', userId: ME, buyerId: ME, sellerId: 'other', coin: 'USDT', status: 'crypto_released',
  amount: '100', fiatAmount: '28100', releasedAt: new Date('2026-10-01T10:00:00Z'), hasDispute: false, ...o,
})

describe('which P2P USDT trades count', () => {
  it('a released, undisputed trade counts, from the user\'s own side', () => {
    expect(classifyUsdtTrade(trade())).toEqual({ kind: 'eligible' })
    expect(toUsdtEventSpec(trade())).toMatchObject({ type: 'BUY', quantity: '100', consideration: '28100', quote: 'PKR', fxRate: '281' })
    expect(toUsdtEventSpec(trade({ buyerId: 'other', sellerId: ME }))).toMatchObject({ type: 'SELL' })
  })
  it('pending, disputed, resolved-dispute and cancelled trades are never counted', () => {
    for (const status of ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent']) {
      expect(classifyUsdtTrade(trade({ status, releasedAt: null }))).toEqual({ kind: 'left_out', reason: 'in_progress' })
    }
    expect(classifyUsdtTrade(trade({ status: 'disputed' }))).toEqual({ kind: 'left_out', reason: 'disputed' })
    expect(classifyUsdtTrade(trade({ status: 'dispute_resolved' }))).toEqual({ kind: 'left_out', reason: 'disputed' })
    expect(classifyUsdtTrade(trade({ hasDispute: true }))).toEqual({ kind: 'left_out', reason: 'disputed' })
    expect(classifyUsdtTrade(trade({ status: 'cancelled' }))).toEqual({ kind: 'ignore' })
  })
  it('other coins, strangers\' trades and unusable amounts are not imported', () => {
    expect(classifyUsdtTrade(trade({ coin: 'BTC' }))).toEqual({ kind: 'ignore' })
    expect(classifyUsdtTrade(trade({ buyerId: 'a', sellerId: 'b' }))).toEqual({ kind: 'ignore' })
    expect(classifyUsdtTrade(trade({ amount: '0' }))).toEqual({ kind: 'left_out', reason: 'invalid_amounts' })
    expect(classifyUsdtTrade(trade({ fiatAmount: 'abc' }))).toEqual({ kind: 'left_out', reason: 'invalid_amounts' })
  })
})

describe('import plan', () => {
  it('creates once, never twice, restores and voids when a trade stops qualifying', () => {
    const t = trade()
    expect(planUsdtImport([t], []).toCreate).toHaveLength(1)
    expect(planUsdtImport([t], [{ id: 'e1', sourceRef: 't1', voidedAt: null }])).toMatchObject({ toCreate: [], alreadyImported: 1 })
    expect(planUsdtImport([t], [{ id: 'e1', sourceRef: 't1', voidedAt: new Date() }]).toRestore).toEqual(['e1'])
    expect(planUsdtImport([trade({ status: 'disputed' })], [{ id: 'e1', sourceRef: 't1', voidedAt: null }]).toVoid).toEqual([{ eventId: 'e1', reason: 'disputed' }])
    expect(planUsdtImport([], [{ id: 'e1', sourceRef: 't1', voidedAt: null }]).toVoid).toEqual([{ eventId: 'e1', reason: 'trade_missing' }])
  })
  it('running it twice gives an empty plan the second time', () => {
    const t = trade()
    const first = planUsdtImport([t], [])
    const existing = first.toCreate.map((s, i) => ({ id: `e${i}`, sourceRef: s.sourceRef, voidedAt: null }))
    expect(planUsdtImport([t], existing)).toEqual({ toCreate: [], toRestore: [], toVoid: [], alreadyImported: 1 })
  })
})

describe('implied rate for USDT entered by hand', () => {
  it('the price paid per USDT is the rate', () => {
    expect(impliedUsdtRate('27900', '100')).toBe('279')
    expect(impliedUsdtRate(null, '100')).toBeNull()
    expect(impliedUsdtRate('0', '100')).toBeNull()
  })
})

// ── The scenarios the owner asked for, run through the real portfolio engine ──
let n = 0
const fromSpec = (s: UsdtEventSpec, assetId = 'USDT'): EventRow => ({
  id: `p${++n}`, assetId, type: s.type, occurredAt: s.occurredAt, quantity: s.quantity, consideration: s.consideration, fee: '0',
  basis: null, zeroCost: false, quote: 'PKR', fxRate: s.fxRate,
})
// What the server stamps on an entry typed in by hand for USDT: price per USDT is the rate.
const manual = (type: 'BUY' | 'SELL', quantity: string, consideration: string, at: string): EventRow => ({
  id: `m${++n}`, assetId: 'USDT', type, occurredAt: new Date(at), quantity, consideration, fee: null, basis: null, zeroCost: false,
  quote: 'PKR', fxRate: impliedUsdtRate(consideration, quantity),
})
const mark = (): PriceRow => ({ assetId: 'USDT', price: '1', quote: 'USDT', observedAt: new Date('2026-10-10T00:00:00Z'), source: 'platform' })

describe('profit from buying and selling USDT on the platform', () => {
  const buy = fromSpec(toUsdtEventSpec(trade({ id: 'b', amount: '100', fiatAmount: '28100', releasedAt: new Date('2026-10-01T10:00:00Z') }))!)
  const sell = fromSpec(toUsdtEventSpec(trade({ id: 's', buyerId: 'x', sellerId: ME, amount: '100', fiatAmount: '28500', releasedAt: new Date('2026-10-02T10:00:00Z') }))!)

  it('buy 100 at 281, sell 100 at 285: profit PKR 400, calculated automatically', () => {
    const r = buildSummary({ events: [buy, sell], prices: [mark()], currency: 'PKR', platformRate: '283' })
    expect(r.summary.knownRealized).toBe('400')
    expect(r.summary.positions[0]!.quantity).toBe('0')
    expect(r.summary.partial).toBe(false)
  })
  it('the same trades in USDT are USDT-neutral (100 in, 100 out): the profit lives in PKR, and nothing is left out', () => {
    const r = buildSummary({ events: [buy, sell], prices: [mark()], currency: 'USDT', platformRate: '283' })
    expect(r.fxUnavailableAssets).toEqual([])
    expect(r.summary.knownRealized).toBe('0')
    expect(r.summary.partial).toBe(false)
  })
  it('holding what is left is valued at the current rate against what it cost', () => {
    const r = buildSummary({ events: [buy], prices: [mark()], currency: 'PKR', platformRate: '283' })
    const p = r.summary.positions[0]!
    expect(p.knownRemainingBasis).toBe('28100')
    expect(p.value).toBe('28300') // 100 USDT x 283
    expect(p.unrealized).toBe('200')
  })
})

describe('mixing platform trades with USDT bought or sold outside the platform', () => {
  it('FIFO runs across both, oldest first: platform 100 @281, outside 50 @279, then sell 120 @285 -> PKR 520', () => {
    const events = [
      fromSpec(toUsdtEventSpec(trade({ id: 'b', amount: '100', fiatAmount: '28100', releasedAt: new Date('2026-10-01T10:00:00Z') }))!),
      manual('BUY', '50', '13950', '2026-10-02T10:00:00Z'),
      fromSpec(toUsdtEventSpec(trade({ id: 's', buyerId: 'x', sellerId: ME, amount: '120', fiatAmount: '34200', releasedAt: new Date('2026-10-03T10:00:00Z') }))!),
    ]
    const r = buildSummary({ events, prices: [mark()], currency: 'PKR', platformRate: '280' })
    const p = r.summary.positions[0]!
    expect(r.summary.knownRealized).toBe('520') // (285-281) x 100 + (285-279) x 20
    expect(p.quantity).toBe('30')
    expect(p.knownRemainingBasis).toBe('8370') // 30 x 279 left
    expect(p.unrealized).toBe('30') // 30 USDT x 280 = 8400
    expect(r.summary.partial).toBe(false)
  })
  it('an old outside purchase still converts in the USDT view, because for USDT the price is the rate', () => {
    const events = [
      manual('BUY', '50', '13950', '2026-01-02T10:00:00Z'), // months ago: no stored platform rate
      fromSpec(toUsdtEventSpec(trade())!),
    ]
    const r = buildSummary({ events, prices: [mark()], currency: 'USDT', platformRate: '280' })
    expect(r.fxUnavailableAssets).toEqual([])
    expect(r.summary.positions[0]!.quantity).toBe('150')
    expect(r.summary.positions[0]!.knownRemainingBasis).toBe('150')
    expect(r.summary.partial).toBe(false)
  })
  it('selling more than the history shows is flagged, never turned into imaginary profit', () => {
    const r = buildSummary({ events: [manual('BUY', '10', '2800', '2026-10-01T00:00:00Z'), manual('SELL', '15', '4275', '2026-10-02T00:00:00Z')], prices: [mark()], currency: 'PKR', platformRate: '280' })
    expect(r.summary.positions[0]!.unresolvedSales).toHaveLength(1)
    expect(r.summary.partial).toBe(true)
  })
})

describe('one import report', () => {
  it('adds the USDT counts to the community-token counts', () => {
    const ctm = { dryRun: false, created: 2, restored: 0, voided: 1, alreadyImported: 3, recordedManually: 0, attention: [{ reason: 'disputed', count: 1 }], hasImportedBefore: false, preview: [], skippedForLimit: 0 }
    const usdt = { created: 4, restored: 1, voided: 0, alreadyImported: 2, hasImportedBefore: true, preview: [], skippedForLimit: 1 }
    expect(mergeImportReports(ctm, usdt)).toMatchObject({ created: 6, restored: 1, voided: 1, alreadyImported: 5, hasImportedBefore: true, skippedForLimit: 1, attention: [{ reason: 'disputed', count: 1 }] })
  })
})
