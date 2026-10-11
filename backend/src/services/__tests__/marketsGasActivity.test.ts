/**
 * Gas-token market page: "Recent gas purchases" feed (getMarketActivityBySlug → getGasTokenActivity).
 * Pure mocks — no DB, Redis or network. Covers the query contract (delivered only, free grants
 * excluded, newest first, capped), network labelling, anonymisation, the 60s cache, and the
 * failure path (reports 'unavailable', is never cached, recovers on the next call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
}
const dbMock = {
  ctmToken: { findUnique: vi.fn(async () => null) },
  gasTokenConfig: { count: vi.fn(async () => 1) },
  gasFeeOrder: { findMany: vi.fn() },
}

vi.mock('../../lib/prisma', () => ({ db: dbMock }))
vi.mock('../../lib/redis', () => ({ redis: redisMock }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../marketplace.service', () => ({ getMarketRatesSummary: vi.fn(), getUsdtReferenceRate: vi.fn(), getUsdtPriceHistory: vi.fn() }))
vi.mock('../../ctm/ctm.token.service', () => ({ getTokenMarketInsight: vi.fn(), getTokenPriceHistory: vi.fn(), getTokenBySlug: vi.fn() }))

const { getMarketActivityBySlug } = await import('../markets.service')

const order = (iso: string, network: string, symbol = 'ETH', fullName: string | null = 'Ahmed Bart') => ({
  deliveredAt: new Date(iso),
  gasAmountNative: { toString: () => '0.01' },
  gasAmountUSD: 4.25,
  user: fullName ? { fullName } : null,
  gasTokenConfig: { symbol, chain: { networkLabel: network } },
})

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  dbMock.ctmToken.findUnique.mockResolvedValue(null)
  dbMock.gasTokenConfig.count.mockResolvedValue(1)
})

describe('gas purchase activity', () => {
  it('queries only delivered, non-free-grant orders for the page priceSymbol, newest first, capped at 10', async () => {
    dbMock.gasFeeOrder.findMany.mockResolvedValue([])
    await getMarketActivityBySlug('eth')
    const args = dbMock.gasFeeOrder.findMany.mock.calls[0]![0]
    expect(args.where).toMatchObject({ status: 'delivered', isFreeGrant: false, gasTokenConfig: { priceSymbol: 'ETH' } })
    expect(args.orderBy).toEqual({ deliveredAt: 'desc' })
    expect(args.take).toBe(10)
  })

  it('returns buyer-name entries in the DB order and exposes no other private fields', async () => {
    dbMock.gasFeeOrder.findMany.mockResolvedValue([
      order('2026-09-10T02:20:16.717Z', 'ERC20'),
      order('2026-08-30T07:51:49.666Z', 'Base'),
    ])
    const a = await getMarketActivityBySlug('eth')
    expect(a.gasPurchases).toEqual({
      status: 'ok',
      items: [
        { buyer: 'Ahmed Bart', network: 'ERC20', symbol: 'ETH', amount: '0.01', amountUsd: 4.25, at: '2026-09-10T02:20:16.717Z' },
        { buyer: 'Ahmed Bart', network: 'Base', symbol: 'ETH', amount: '0.01', amountUsd: 4.25, at: '2026-08-30T07:51:49.666Z' },
      ],
    })
    // The select must never reach for user / order / payment / wallet fields.
    const sel = dbMock.gasFeeOrder.findMany.mock.calls[0]![0].select
    expect(Object.keys(sel).sort()).toEqual(['deliveredAt', 'gasAmountNative', 'gasAmountUSD', 'gasTokenConfig', 'user'])
    expect(sel.user).toEqual({ select: { fullName: true } })
    expect(JSON.stringify(a)).not.toMatch(/orderRef|userId|walletAddress|txHash|email/i)
  })

  it('a genuinely empty result is "ok" with no items (not unavailable)', async () => {
    dbMock.gasFeeOrder.findMany.mockResolvedValue([])
    const a = await getMarketActivityBySlug('sui')
    expect(a.gasPurchases).toEqual({ status: 'ok', items: [] })
  })

  it('serves repeat calls from the 60s cache, with a 60s expiry', async () => {
    dbMock.gasFeeOrder.findMany.mockResolvedValue([order('2026-09-10T02:20:16.717Z', 'ERC20')])
    await getMarketActivityBySlug('eth')
    await getMarketActivityBySlug('eth')
    await getMarketActivityBySlug('eth')
    expect(dbMock.gasFeeOrder.findMany).toHaveBeenCalledTimes(1)
    expect(redisMock.set).toHaveBeenCalledWith('markets:gas-activity:ETH', expect.any(String), 'EX', 60)
    // Expiry: once the key is gone the next request re-queries.
    store.clear()
    await getMarketActivityBySlug('eth')
    expect(dbMock.gasFeeOrder.findMany).toHaveBeenCalledTimes(2)
  })

  it('a DB failure reports unavailable, is NOT cached as empty, and recovers on the next call', async () => {
    dbMock.gasFeeOrder.findMany.mockRejectedValueOnce(new Error('db down'))
    const failed = await getMarketActivityBySlug('bnb')
    expect(failed.gasPurchases).toEqual({ status: 'unavailable', items: [] })
    expect(store.size).toBe(0)

    dbMock.gasFeeOrder.findMany.mockResolvedValueOnce([order('2026-09-29T15:49:14.666Z', 'BEP20', 'BNB')])
    const recovered = await getMarketActivityBySlug('bnb')
    expect(recovered.gasPurchases?.status).toBe('ok')
    expect(recovered.gasPurchases?.items).toHaveLength(1)
  })

  it('a Redis outage never breaks the feed and makes no external HTTP call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    redisMock.get.mockRejectedValueOnce(new Error('redis down'))
    redisMock.set.mockRejectedValueOnce(new Error('redis down'))
    dbMock.gasFeeOrder.findMany.mockResolvedValue([order('2026-09-10T02:20:16.717Z', 'ERC20')])
    const a = await getMarketActivityBySlug('eth')
    expect(a.gasPurchases?.status).toBe('ok')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
