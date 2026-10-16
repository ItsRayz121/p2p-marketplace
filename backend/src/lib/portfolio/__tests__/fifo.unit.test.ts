import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { computePosition, summarizePortfolio, type TradeEvent } from '../fifo'

let n = 0
const ev = (e: Partial<TradeEvent> & Pick<TradeEvent, 'assetId' | 'type' | 'quantity'>): TradeEvent =>
  ({ id: `e${++n}`, at: `2026-01-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00Z`, ...e })

const buy = (assetId: string, quantity: string, consideration: string, fee = '0', at?: string): TradeEvent =>
  ev({ assetId, type: 'BUY', quantity, consideration, fee, ...(at ? { at } : {}) })
const sell = (assetId: string, quantity: string, consideration: string, fee = '0', at?: string): TradeEvent =>
  ev({ assetId, type: 'SELL', quantity, consideration, fee, ...(at ? { at } : {}) })

// Fictional spec fixture (section 10.1). Prices are test values, not market data.
const mecEvents = (): TradeEvent[] => [
  buy('MEC', '100', '100000', '1000', '2026-01-01T00:00:00Z'),
  sell('MEC', '40', '52000', '400', '2026-01-02T00:00:00Z'),
]

describe('spec fixture 10.1: Buy 100 @1,000 fee 1,000; sell 40 @1,300 fee 400', () => {
  it('matches every number in the spec', () => {
    const s = summarizePortfolio(mecEvents(), { MEC: { price: '1200' } })
    const p = s.positions[0]!
    expect(p.quantity).toBe('60')
    expect(p.knownRemainingBasis).toBe('60600')
    expect(p.realizedKnown).toBe('11200')
    expect(p.value).toBe('72000')
    expect(p.unrealized).toBe('11400')
    expect(s.knownTotalPnl).toBe('22600')
    expect(s.partial).toBe(false)
  })
  it('intermediate numbers: basis 101,000, net proceeds 51,600, matched basis 40,400', () => {
    const afterBuy = computePosition('MEC', [mecEvents()[0]!])
    expect(afterBuy.knownRemainingBasis).toBe('101000')
    const p = computePosition('MEC', mecEvents())
    // realized = net proceeds - matched basis = 51,600 - 40,400
    expect(p.realizedKnown).toBe('11200')
  })
})

describe('lots, partial sales and exact rounding', () => {
  it('sale crossing two lots at different prices', () => {
    const p = computePosition('A', [
      buy('A', '10', '1000', '0', '2026-01-01T00:00:00Z'),
      buy('A', '10', '2000', '0', '2026-01-02T00:00:00Z'),
      sell('A', '15', '4500', '3', '2026-01-03T00:00:00Z'),
    ])
    // net 4,497 split 10/5 -> 2,998 + 1,499 ; basis 1,000 + 1,000 ; realized 2,497
    expect(p.realizedKnown).toBe('2497')
    expect(p.quantity).toBe('5')
    expect(p.knownRemainingBasis).toBe('1000')
  })
  it('FIFO consumes the oldest lot first regardless of input order', () => {
    const p = computePosition('A', [
      sell('A', '5', '500', '0', '2026-01-03T00:00:00Z'),
      buy('A', '10', '2000', '0', '2026-01-02T00:00:00Z'),
      buy('A', '10', '1000', '0', '2026-01-01T00:00:00Z'),
    ])
    expect(p.realizedKnown).toBe('0') // 500 proceeds - 5 * 100 oldest unit cost
    expect(p.knownRemainingBasis).toBe('2500')
  })
  it('basis split conserves the total exactly (3 units, basis 100, sold one at a time)', () => {
    const base = [buy('A', '3', '100', '0', '2026-01-01T00:00:00Z')]
    const sells = ['02', '03', '04'].map((d) => sell('A', '1', '0', '0', `2026-01-${d}T00:00:00Z`))
    // proceeds 0, so realized = -(matched basis); the three matched pieces must add to exactly 100
    expect(computePosition('A', [...base, ...sells]).realizedKnown).toBe('-100')
    expect(computePosition('A', [...base, ...sells.slice(0, 2)]).knownRemainingBasis).toBe('33.33333333')
  })
  it('proceeds remainder goes to the last piece so shares sum exactly', () => {
    const p = computePosition('A', [
      buy('A', '1', '1', '0', '2026-01-01T00:00:00Z'),
      buy('A', '1', '1', '0', '2026-01-02T00:00:00Z'),
      buy('A', '1', '1', '0', '2026-01-03T00:00:00Z'),
      sell('A', '3', '100', '0', '2026-01-04T00:00:00Z'),
    ])
    expect(p.realizedKnown).toBe('97') // 100 - 3, exact, no 0.00000001 drift
  })
  it('uses exact decimals, not floats (0.1 + 0.2 sold as 0.3 leaves exactly zero)', () => {
    const p = computePosition('A', [
      buy('A', '0.1', '10', '0', '2026-01-01T00:00:00Z'),
      buy('A', '0.2', '20', '0', '2026-01-02T00:00:00Z'),
      sell('A', '0.3', '30', '0', '2026-01-03T00:00:00Z'),
    ])
    expect(p.quantity).toBe('0')
    expect(p.knownRemainingBasis).toBe('0')
    expect(p.realizedKnown).toBe('0')
  })
  it('handles extremely small quantities and large values', () => {
    const p = computePosition('A', [
      buy('A', '0.000000000000000001', '1', '0', '2026-01-01T00:00:00Z'),
      buy('A', '9999999999999999999999999999', '9999999999999999999999999999', '0', '2026-01-02T00:00:00Z'),
    ])
    expect(p.quantity).toBe('9999999999999999999999999999.000000000000000001')
  })
  it('equal timestamps are ordered deterministically by seq then id', () => {
    const at = '2026-01-01T00:00:00Z'
    const a = [
      { ...buy('A', '1', '10', '0', at), id: 'b', seq: 2 },
      { ...buy('A', '1', '20', '0', at), id: 'a', seq: 1 },
      { ...sell('A', '1', '15', '0', at), id: 'c', seq: 3 },
    ]
    // seq 1 (cost 20) is the oldest lot, so selling one unit at 15 realizes -5, in any input order
    expect(computePosition('A', a).realizedKnown).toBe('-5')
    expect(computePosition('A', [...a].reverse()).realizedKnown).toBe('-5')
  })
})

describe('unknown stays unknown', () => {
  it('unknown opening basis is not zero: no unrealized P&L, flagged partial', () => {
    const s = summarizePortfolio(
      [ev({ assetId: 'X', type: 'OPENING', quantity: '10' })],
      { X: { price: '5' } },
    )
    expect(s.positions[0]!.value).toBe('50')
    expect(s.positions[0]!.unrealized).toBeNull()
    expect(s.pricedValue).toBe('50') // value is still shown
    expect(s.knownUnrealized).toBe('0')
    expect(s.unknownBasisAssets).toEqual(['X'])
    expect(s.partial).toBe(true)
  })
  it('zero basis needs an explicit declaration', () => {
    const e = ev({ assetId: 'X', type: 'OPENING', quantity: '10', basis: '0' })
    expect(() => computePosition('X', [e])).toThrow(/zeroCost/)
    const ok = computePosition('X', [{ ...e, zeroCost: true }])
    expect(ok.basisComplete).toBe(true)
    expect(ok.knownRemainingBasis).toBe('0')
  })
  it('missing price is not zero: asset is unpriced and the summary is partial', () => {
    const s = summarizePortfolio([buy('Y', '1', '100')], { Y: { price: null } })
    expect(s.positions[0]!.value).toBeNull()
    expect(s.pricedValue).toBe('0')
    expect(s.unpricedAssets).toEqual(['Y'])
    expect(s.partial).toBe(true)
  })
  it('selling units from an unknown-basis lot makes realized incomplete', () => {
    const p = computePosition('X', [
      ev({ assetId: 'X', type: 'OPENING', quantity: '10', at: '2026-01-01T00:00:00Z' }),
      sell('X', '4', '100', '0', '2026-01-02T00:00:00Z'),
    ])
    expect(p.realizedComplete).toBe(false)
    expect(p.realizedKnown).toBe('0')
  })
  it('a sale exceeding recorded holdings creates no imaginary profit and is queued as unresolved', () => {
    const s = summarizePortfolio(
      [buy('Z', '10', '100', '0', '2026-01-01T00:00:00Z'), sell('Z', '15', '300', '0', '2026-01-02T00:00:00Z')],
      { Z: { price: '10' } },
    )
    const p = s.positions[0]!
    expect(p.unresolvedSales[0]!.quantity).toBe('5')
    expect(p.quantity).toBe('0')
    // only the 10 matched units (2/3 of the 300 proceeds = 200) count: 200 - 100
    expect(p.realizedKnown).toBe('100')
    expect(s.unresolvedAssets).toEqual(['Z'])
    expect(s.partial).toBe(true)
  })
  it('a sale before any acquisition is unresolved, not a short-sale gain', () => {
    const p = computePosition('Z', [sell('Z', '5', '500', '0', '2026-01-01T00:00:00Z'), buy('Z', '5', '100', '0', '2026-01-02T00:00:00Z')])
    expect(p.realizedKnown).toBe('0')
    expect(p.unresolvedSales[0]!.quantity).toBe('5')
    expect(p.quantity).toBe('5')
  })
  it('a fully sold position still contributes its realized result', () => {
    const s = summarizePortfolio(
      [buy('S', '1', '10', '0', '2026-01-01T00:00:00Z'), sell('S', '1', '25', '0', '2026-01-02T00:00:00Z')],
      {},
    )
    expect(s.positions[0]!.quantity).toBe('0')
    expect(s.knownRealized).toBe('15')
    expect(s.partial).toBe(false) // nothing held, so no price needed
  })
})

describe('spec fixture 10.13: aggregate with a fifth, unpriced custom asset', () => {
  const base = (): TradeEvent[] => [
    ...mecEvents(),
    buy('USDT', '400', '111200'),
    buy('SDA', '1000', '10000'),
    buy('RUBI', '1000', '12000'),
  ]
  const marks = { MEC: { price: '1200' }, USDT: { price: '280' }, SDA: { price: '8' }, RUBI: { price: '15' } }

  it('priced holdings 207,000; known basis 193,800; unrealized 13,200; realized 11,200; total 24,400', () => {
    const s = summarizePortfolio(base(), marks)
    expect(s.pricedValue).toBe('207000')
    expect(s.knownRemainingBasis).toBe('193800')
    expect(s.knownUnrealized).toBe('13200')
    expect(s.knownRealized).toBe('11200')
    expect(s.knownTotalPnl).toBe('24400')
    expect(s.partial).toBe(false)
  })
  it('a custom asset with no price and unknown basis forces a partial warning and is never valued at zero', () => {
    const events = [...base(), ev({ assetId: 'custom-1', type: 'OPENING', quantity: '500' })]
    const s = summarizePortfolio(events, { ...marks, 'custom-1': { price: null } })
    expect(s.partial).toBe(true)
    expect(s.unpricedAssets).toEqual(['custom-1'])
    expect(s.unknownBasisAssets).toEqual(['custom-1'])
    // known totals are unchanged by the excluded asset
    expect(s.pricedValue).toBe('207000')
    expect(s.knownTotalPnl).toBe('24400')
    expect(s.positions.find((p) => p.assetId === 'custom-1')!.value).toBeNull()
  })
})

describe('metadata independence (corrections 6 and 8)', () => {
  it('results depend only on events and marks: renaming/re-linking an asset changes nothing', () => {
    const assets = new Map([['MEC', { name: 'Meta Earth', symbol: 'MEC', sourceUrl: 'https://a.example' }]])
    const events = mecEvents()
    const before = summarizePortfolio(events, { MEC: { price: '1200' } })
    assets.set('MEC', { name: 'Totally Different Name', symbol: 'ZZZ', sourceUrl: 'https://b.example' })
    const after = summarizePortfolio(events, { MEC: { price: '1200' } })
    expect(after).toEqual(before)
  })
  it('two assets with identical metadata but different ids never merge', () => {
    const s = summarizePortfolio(
      [buy('id-1', '1', '10', '0', '2026-01-01T00:00:00Z'), buy('id-2', '1', '10', '0', '2026-01-01T00:00:00Z')],
      { 'id-1': { price: '12' }, 'id-2': { price: '12' } },
    )
    expect(s.positions.map((p) => p.assetId)).toEqual(['id-1', 'id-2'])
    expect(s.pricedValue).toBe('24')
  })
  it('the engine source never references asset metadata, the database, or custody/settlement tables', () => {
    const src = readFileSync(path.resolve(__dirname, '../fifo.ts'), 'utf8')
    for (const word of ['sourceUrl', 'symbol', 'contractAddress', 'portfolioAsset', 'db.', 'wallet', 'Wallet', 'Transaction', 'CtmTrade', 'fetch(']) {
      expect(src, `fifo.ts should not mention ${word}`).not.toContain(word)
    }
  })
})

describe('input validation', () => {
  it.each([
    ['negative quantity', { quantity: '-1' }], ['zero quantity', { quantity: '0' }], ['NaN', { quantity: 'NaN' }],
    ['scientific notation', { quantity: '1e3' }], ['too many decimals', { quantity: '0.0000000000000000001' }],
    ['oversized', { quantity: '1'.repeat(40) }], ['float-ish text', { quantity: '1,5' }],
  ])('rejects %s', (_label, over) => {
    expect(() => computePosition('A', [buy('A', '1', '1')].map((e) => ({ ...e, ...over })))).toThrow(/invalid/)
  })
  it('rejects negative fees/consideration, bad dates and duplicate event ids', () => {
    expect(() => computePosition('A', [buy('A', '1', '-5')])).toThrow(/invalid/)
    expect(() => computePosition('A', [buy('A', '1', '5', '-1')])).toThrow(/invalid/)
    expect(() => computePosition('A', [buy('A', '1', '5', '0', 'not-a-date'), buy('A', '1', '5', '0', '2026-01-01T00:00:00Z')])).toThrow(/invalid date/)
    const e = buy('A', '1', '5')
    expect(() => computePosition('A', [e, { ...e }])).toThrow(/duplicate/)
  })
})
