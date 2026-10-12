import { describe, it, expect } from 'vitest'
import {
  bucketKey, bucketKeys, change, classifyCategory, dailyActivity, deliveryOutcome, demandByAsset, isSettled,
  previousWindow, summarizeCohort, summarizePayments, userSeries, userTotals, recipientKey,
  type InsightOrderRow,
} from '../gas.insights'

let n = 0
function order(over: Partial<InsightOrderRow> = {}): InsightOrderRow {
  n++
  const createdAt = over.createdAt ?? new Date('2026-10-10T10:00:00Z')
  return {
    id: `o${n}`, userId: `u${n}`, toAddress: `0xaddr${n}`, chain: 'BSC', tokenSymbol: 'BNB', isFreeGrant: false,
    paymentCoin: 'USDT', paymentNetwork: 'BEP20', status: 'delivered', retryCount: 0, paymentTxHash: `0xtx${n}`,
    failureReason: null, deliveryTxHash: `0xd${n}`, gasAmountUSD: 1, createdAt,
    deliveredAt: new Date(createdAt.getTime() + 60_000), paymentVerifiedAt: createdAt, updatedAt: createdAt, ...over,
  }
}

describe('categories', () => {
  it('are mutually exclusive and keep unknown visible', () => {
    expect(classifyCategory({ isFreeGrant: true, paymentCoin: 'PKR' })).toBe('free')
    expect(classifyCategory({ isFreeGrant: false, paymentCoin: 'PKR' })).toBe('pkr')
    expect(classifyCategory({ isFreeGrant: false, paymentCoin: 'USDT' })).toBe('crypto')
    expect(classifyCategory({ isFreeGrant: false, paymentCoin: '' })).toBe('unknown')
  })
  it('counts shares from one cohort and never drops unknown', () => {
    const s = summarizeCohort([order(), order({ paymentCoin: 'PKR' }), order({ isFreeGrant: true, paymentCoin: 'USDT' }), order({ paymentCoin: '' })])
    expect(s.total).toBe(4)
    expect(s.byCategory).toEqual({ crypto: 1, pkr: 1, free: 1, unknown: 1 })
  })
})

describe('grants vs paid', () => {
  it('excludes free grants from paid purchases and payment summaries but tracks subsidy', () => {
    const rows = [order(), order({ isFreeGrant: true, paymentVerifiedAt: null, gasAmountUSD: 0.5 })]
    const s = summarizeCohort(rows)
    expect(s.paidPurchases).toBe(1)
    expect(s.freeGas).toEqual({ delivered: 1, uniqueRecipients: 1, subsidyUsd: 0.5 })
    expect(summarizePayments(rows)).toMatchObject({ paymentOrders: 1, settled: 1, settledCrypto: 1, settledPkr: 0 })
    expect(isSettled(rows[1]!)).toBe(false)
  })
})

describe('delivery outcome', () => {
  it('counts expired/cancelled/unpaid-failed as neither success nor failure', () => {
    expect(deliveryOutcome(order({ status: 'expired', deliveredAt: null, deliveryTxHash: null, paymentVerifiedAt: null, paymentTxHash: null }))).toBe('none')
    expect(deliveryOutcome(order({ status: 'cancelled', deliveredAt: null }))).toBe('none')
    expect(deliveryOutcome(order({ status: 'failed', paymentTxHash: null, retryCount: 0, paymentVerifiedAt: null }))).toBe('none')
  })
  it('treats paid-failed and refund-lifecycle orders as terminal failures, in-flight as pending', () => {
    expect(deliveryOutcome(order({ status: 'failed', retryCount: 3, deliveredAt: null, deliveryTxHash: null }))).toBe('failed')
    expect(deliveryOutcome(order({ status: 'refunded', deliveredAt: null, deliveryTxHash: null }))).toBe('failed')
    expect(deliveryOutcome(order({ status: 'sending', deliveredAt: null, deliveryTxHash: null }))).toBe('pending')
  })
  it('success rate = delivered / (delivered + terminal failures), pending excluded', () => {
    const s = summarizeCohort([
      order(), order(), order(),
      order({ status: 'failed', retryCount: 3, deliveredAt: null, deliveryTxHash: null }),
      order({ status: 'sending', deliveredAt: null, deliveryTxHash: null }),
      order({ status: 'expired', deliveredAt: null, deliveryTxHash: null, paymentVerifiedAt: null, paymentTxHash: null }),
    ])
    expect(s.successRate).toBeCloseTo(0.75)
    expect(s.pending).toBe(1)
    expect(summarizeCohort([]).successRate).toBeNull()
  })
  it('counts a retried order once', () => {
    expect(summarizeCohort([order({ retryCount: 4 })]).delivered).toBe(1)
  })
})

describe('change', () => {
  it('handles zero baselines and normal percentages', () => {
    expect(change(5, 0).kind).toBe('new')
    expect(change(0, 0).kind).toBe('no_prior')
    expect(change(15, 10)).toMatchObject({ kind: 'pct', pct: 50 })
    expect(change(5, 10).pct).toBe(-50)
    expect(change(3, null).kind).toBe('unavailable')
  })
})

describe('windows and buckets', () => {
  it('previous window is the adjacent equal-length span', () => {
    const w = { from: new Date('2026-10-06T00:00:00Z'), to: new Date('2026-10-12T23:59:59.999Z') }
    const p = previousWindow(w)!
    expect(p.to.getTime()).toBe(w.from.getTime() - 1)
    expect(p.to.getTime() - p.from!.getTime()).toBe(w.to.getTime() - w.from.getTime())
    expect(previousWindow({ from: null, to: new Date() })).toBeNull()
  })
  it('buckets by the requested timezone, not UTC', () => {
    const d = new Date('2026-10-10T20:00:00Z') // 01:00 on the 11th in Karachi (UTC+5)
    expect(bucketKey(d, 'UTC', 'day')).toBe('2026-10-10')
    expect(bucketKey(d, 'Asia/Karachi', 'day')).toBe('2026-10-11')
  })
  it('emits zero-filled day keys', () => {
    expect(bucketKeys(new Date('2026-10-08T00:00:00Z'), new Date('2026-10-11T12:00:00Z'), 'UTC', 'day'))
      .toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
  })
  it('stacked daily counts reconcile to the cohort total', () => {
    const w = { from: new Date('2026-10-09T00:00:00Z'), to: new Date('2026-10-10T23:59:59Z') }
    const cohort = [order({ createdAt: new Date('2026-10-09T05:00:00Z') }), order({ createdAt: new Date('2026-10-10T05:00:00Z'), isFreeGrant: true })]
    const pts = dailyActivity(cohort, [], w, previousWindow(w), 'UTC', 'day')
    expect(pts.reduce((a, p) => a + p.total, 0)).toBe(2)
    expect(pts.map((p) => [p.crypto, p.free])).toEqual([[1, 0], [0, 1]])
  })
})

describe('users', () => {
  const w = { from: new Date('2026-10-10T00:00:00Z'), to: new Date('2026-10-11T23:59:59Z') }
  it('new = first delivery ever in period; returning has an earlier delivery; totals are distinct', () => {
    const a = order({ userId: 'A', deliveredAt: new Date('2026-10-10T08:00:00Z') })
    const a2 = order({ userId: 'A', deliveredAt: new Date('2026-10-11T08:00:00Z') })
    const b = order({ userId: 'B', deliveredAt: new Date('2026-10-11T09:00:00Z') })
    const firstEver = new Map([[recipientKey(a), new Date('2026-10-10T08:00:00Z')], [recipientKey(b), new Date('2026-09-01T00:00:00Z')]])
    const deliveries = [a, a2, b]
    expect(userTotals(deliveries, firstEver, w)).toEqual({ unique: 2, newUsers: 1 })
    const pts = userSeries(deliveries, firstEver, w, 'UTC', 'day')
    expect(pts).toEqual([
      { key: '2026-10-10', newUsers: 1, returningUsers: 0 },
      { key: '2026-10-11', newUsers: 0, returningUsers: 2 },
    ])
  })
})

describe('demand', () => {
  it('keeps the same symbol on different networks apart and separates paid from free', () => {
    const cohort = [
      order({ tokenSymbol: 'ETH', chain: 'ETH' }), order({ tokenSymbol: 'ETH', chain: 'BASE' }), order({ tokenSymbol: 'ETH', chain: 'BASE' }),
      order({ tokenSymbol: 'BNB', chain: 'BSC' }), order({ tokenSymbol: 'BNB', chain: 'OPBNB' }),
      order({ tokenSymbol: 'BNB', chain: 'BSC', isFreeGrant: true, paymentVerifiedAt: null }),
    ]
    const paid = demandByAsset(cohort, 'paid')
    expect(paid.map((d) => `${d.asset}:${d.chain}:${d.delivered}`)).toEqual(['ETH:BASE:2', 'ETH:ETH:1', 'BNB:BSC:1', 'BNB:OPBNB:1'])
    expect(paid[0]!.share).toBeCloseTo(0.4)
    expect(demandByAsset(cohort, 'free')).toHaveLength(1)
    expect(demandByAsset(cohort, 'all').reduce((a, d) => a + d.delivered, 0)).toBe(6)
  })
})
