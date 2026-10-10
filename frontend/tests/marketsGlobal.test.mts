import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExternalRow, globalChange24h, globalChartLabel } from '../src/lib/marketsGlobal.ts'

const gas = { kind: 'gas', dataSource: 'live_market', changePercent24h: null }
const ok = (c: number | null | undefined) => ({ status: 'ok', change24hPct: c })

test('only explicitly externally priced (gas / live_market) rows are external', () => {
  assert.equal(isExternalRow(gas), true)
  assert.equal(isExternalRow({ kind: 'ctm', dataSource: 'none' }), false)
  assert.equal(isExternalRow({ kind: 'ctm', dataSource: 'live_market' }), false)
  assert.equal(isExternalRow({ kind: 'usdt', dataSource: 'completed_trades' }), false)
  assert.equal(isExternalRow({ kind: 'gas', dataSource: 'none' }), false)
})

test('local rows (RUPCHAIN TRADES, USDT, CTM) never get a global change', () => {
  assert.equal(globalChange24h({ kind: 'usdt', dataSource: 'completed_trades', changePercent24h: null }, ok(5)), null)
  assert.equal(globalChange24h({ kind: 'ctm', dataSource: 'none', changePercent24h: null }, ok(5)), null)
  assert.equal(globalChange24h({ kind: 'ctm', dataSource: 'completed_trades', changePercent24h: 2.1 }, ok(5)), null)
})

test('an external row that already has a local change keeps it', () => {
  assert.equal(globalChange24h({ ...gas, changePercent24h: 1.2 }, ok(9)), null)
  assert.equal(globalChange24h({ ...gas, changePercent24h: 0 }, ok(9)), null) // a genuine local zero is still local
})

test('positive, negative and genuine zero global changes pass through', () => {
  assert.equal(globalChange24h(gas, ok(3.31)), 3.31)
  assert.equal(globalChange24h(gas, ok(-0.43)), -0.43)
  assert.equal(globalChange24h(gas, ok(0)), 0)
})

test('missing, unsupported, unavailable or non-finite data is null, never 0', () => {
  assert.equal(globalChange24h(gas, ok(null)), null)
  assert.equal(globalChange24h(gas, ok(undefined)), null)
  assert.equal(globalChange24h(gas, ok(Number.NaN)), null)
  assert.equal(globalChange24h(gas, { status: 'unsupported' }), null)
  assert.equal(globalChange24h(gas, { status: 'unavailable' }), null)
  assert.equal(globalChange24h(gas, null), null)
})

test('labels name the provider, currency and period, and flag delayed data', () => {
  const s = globalChartLabel({ provider: 'CoinGecko', stale: true, lastUpdated: '2026-10-10T06:04:45.000Z' })
  assert.match(s, /7-day/)
  assert.match(s, /CoinGecko/)
  assert.match(s, /USD/)
  assert.match(s, /Delayed/)
  assert.doesNotMatch(globalChartLabel({ provider: 'CoinGecko', stale: false }), /Delayed/)
})
