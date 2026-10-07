import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  disputeFindMany: vi.fn(),
  ctmDisputeFindMany: vi.fn(),
}))

vi.mock('../prisma', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany },
    dispute: { findMany: mocks.disputeFindMany },
    ctmDispute: { findMany: mocks.ctmDisputeFindMany },
    ad: { updateMany: vi.fn() },
    ctmListing: { updateMany: vi.fn() },
  },
}))

import { assertNotOnTradingHold, assertCounterpartyNotOnHold, countOpenDisputesAgainst, getDisputedUserIds } from '../tradingHold'

beforeEach(() => vi.clearAllMocks())

describe('assertNotOnTradingHold', () => {
  it('passes for a normal user and for an unknown user', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ tradingHold: false, tradingHoldReason: null })
    await expect(assertNotOnTradingHold('u1', 'post')).resolves.toBeUndefined()
    mocks.userFindUnique.mockResolvedValueOnce(null)
    await expect(assertNotOnTradingHold('ghost', 'trade')).resolves.toBeUndefined()
  })

  it('blocks a held user with TRADING_HOLD and includes the reason', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ tradingHold: true, tradingHoldReason: 'did not deliver tokens' })
    await expect(assertNotOnTradingHold('u1', 'post')).rejects.toMatchObject({ code: 'TRADING_HOLD', statusCode: 403 })
    mocks.userFindUnique.mockResolvedValueOnce({ tradingHold: true, tradingHoldReason: 'did not deliver tokens' })
    await expect(assertNotOnTradingHold('u1', 'trade')).rejects.toThrow(/did not deliver tokens/)
  })
})

describe('assertCounterpartyNotOnHold', () => {
  it('blocks trades with a held counterparty without naming the reason', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ tradingHold: true })
    await expect(assertCounterpartyNotOnHold('u2')).rejects.toMatchObject({ code: 'COUNTERPARTY_ON_HOLD' })
    mocks.userFindUnique.mockResolvedValueOnce({ tradingHold: false })
    await expect(assertCounterpartyNotOnHold('u2')).resolves.toBeUndefined()
  })
})

describe('countOpenDisputesAgainst', () => {
  it('counts the respondent (not the opener) across USDT and CTM disputes', async () => {
    // USDT: buyer b1 opened against seller s1 -> s1 is the respondent
    mocks.disputeFindMany.mockResolvedValueOnce([{ openedById: 'b1', trade: { buyerId: 'b1', sellerId: 's1' } }])
    // CTM: seller s1 opened against buyer b2 -> b2 is the respondent; plus b1 vs s1 again
    mocks.ctmDisputeFindMany.mockResolvedValueOnce([
      { openedById: 's1', trade: { buyerId: 'b2', sellerId: 's1' } },
      { openedById: 'b1', trade: { buyerId: 'b1', sellerId: 's1' } },
    ])
    const map = await countOpenDisputesAgainst(['s1', 'b2', 'b1'])
    expect(map.get('s1')).toBe(2)
    expect(map.get('b2')).toBe(1)
    expect(map.has('b1')).toBe(false) // b1 only ever opened disputes
  })

  it('ignores respondents that were not asked about, and empty input', async () => {
    mocks.disputeFindMany.mockResolvedValueOnce([{ openedById: 'x', trade: { buyerId: 'x', sellerId: 'other' } }])
    mocks.ctmDisputeFindMany.mockResolvedValueOnce([])
    expect((await countOpenDisputesAgainst(['s1'])).size).toBe(0)
    expect((await countOpenDisputesAgainst([])).size).toBe(0)
  })
})

describe('getDisputedUserIds', () => {
  it('flags users on hold or with an open dispute against them', async () => {
    mocks.userFindMany.mockResolvedValueOnce([{ id: 'held' }])
    mocks.disputeFindMany.mockResolvedValueOnce([{ openedById: 'a', trade: { buyerId: 'a', sellerId: 'disputed' } }])
    mocks.ctmDisputeFindMany.mockResolvedValueOnce([])
    const set = await getDisputedUserIds(['held', 'disputed', 'clean'])
    expect([...set].sort()).toEqual(['disputed', 'held'])
  })
})
