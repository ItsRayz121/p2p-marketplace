import { describe, it, expect } from 'vitest'
import { classifyTrade, describeTrade, toEventSpec, makePlan, type CtmTradeFacts } from '../ctmImport'

const done = new Date('2026-10-01T10:00:00Z')
const trade = (o: Partial<CtmTradeFacts> = {}): CtmTradeFacts => ({
  id: 't1', displayRef: 'CTM-1001', userId: 'buyer', buyerId: 'buyer', sellerId: 'seller', status: 'completed',
  settlementType: 'MANUAL', completedAt: done, tokenId: 'tok1', tokenAmount: '100.00000000', fiatAmount: '125000.00',
  paymentCurrency: 'PKR', usdtAmount: null, hasDispute: false, adminForceCompleted: false, autoCompleted: false,
  verifiedTokenProof: false, ...o,
})

describe('what counts as settled', () => {
  it('a normally completed manual trade is imported, as buyer-confirmed', () => {
    expect(classifyTrade(trade())).toEqual({ kind: 'eligible', evidence: 'buyer_confirmed' })
  })
  it('on-chain and hybrid trades need a VERIFIED token-transfer proof', () => {
    for (const settlementType of ['ON_CHAIN', 'HYBRID'] as const) {
      expect(classifyTrade(trade({ settlementType }))).toEqual({ kind: 'attention', reason: 'unverified_transfer' })
      expect(classifyTrade(trade({ settlementType, verifiedTokenProof: true }))).toEqual({ kind: 'eligible', evidence: 'on_chain_verified' })
    }
  })
  it.each([
    ['awaiting_payment'], ['payment_uploaded'], ['payment_confirmed'], ['seller_transferring'], ['proof_submitted'], ['buyer_confirming'],
  ])('%s is still in progress, never imported', (status) => {
    expect(classifyTrade(trade({ status, completedAt: null }))).toEqual({ kind: 'attention', reason: 'in_progress' })
  })
  it('a disputed trade is added once the dispute is resolved: buyer wins counts at the ruling date, seller wins is nothing exchanged, a split stays out', () => {
    const resolvedAt = new Date('2026-10-05T09:00:00Z')
    const ruled = { status: 'dispute_resolved', completedAt: null, hasDispute: false, resolvedAt }
    expect(classifyTrade(trade({ ...ruled, ruling: 'buyer_wins' }))).toEqual({ kind: 'eligible', evidence: 'admin_ruling' })
    expect(toEventSpec(trade({ ...ruled, ruling: 'buyer_wins' }))).toMatchObject({ type: 'BUY', occurredAt: resolvedAt, quantity: '100', consideration: '125000' })
    expect(classifyTrade(trade({ ...ruled, ruling: 'seller_wins' }))).toEqual({ kind: 'ignore' })
    expect(classifyTrade(trade({ ...ruled, hasDispute: true }))).toEqual({ kind: 'attention', reason: 'disputed' })
    expect(classifyTrade(trade({ status: 'disputed', completedAt: null, hasDispute: true }))).toEqual({ kind: 'attention', reason: 'disputed' })
  })
  it('disputed and dispute-resolved trades are never imported', () => {
    expect(classifyTrade(trade({ status: 'disputed', completedAt: null }))).toEqual({ kind: 'attention', reason: 'disputed' })
    expect(classifyTrade(trade({ status: 'dispute_resolved' }))).toEqual({ kind: 'attention', reason: 'disputed' })
  })
  it('a completed trade that ever had a dispute is not imported (an admin force-complete closes the dispute but leaves the row)', () => {
    expect(classifyTrade(trade({ hasDispute: true }))).toEqual({ kind: 'attention', reason: 'disputed' })
  })
  it('an administrator-completed trade is not proof of settlement', () => {
    expect(classifyTrade(trade({ adminForceCompleted: true }))).toEqual({ kind: 'attention', reason: 'admin_completed' })
  })
  it('a timer-completed trade (buyer never confirmed) is not imported', () => {
    expect(classifyTrade(trade({ autoCompleted: true }))).toEqual({ kind: 'attention', reason: 'auto_completed' })
  })
  it('even verified on-chain evidence does not override an admin/timer/dispute completion', () => {
    const base = { settlementType: 'ON_CHAIN' as const, verifiedTokenProof: true }
    expect(classifyTrade(trade({ ...base, autoCompleted: true })).kind).toBe('attention')
    expect(classifyTrade(trade({ ...base, adminForceCompleted: true })).kind).toBe('attention')
    expect(classifyTrade(trade({ ...base, hasDispute: true })).kind).toBe('attention')
  })
  it('cancelled and expired trades are ignored entirely (nothing was exchanged)', () => {
    expect(classifyTrade(trade({ status: 'cancelled', completedAt: null }))).toEqual({ kind: 'ignore' })
    expect(classifyTrade(trade({ status: 'expired', completedAt: null }))).toEqual({ kind: 'ignore' })
  })
  it('a "completed" trade without a completion time is not trusted', () => {
    expect(classifyTrade(trade({ completedAt: null })).kind).toBe('attention')
  })
  it('amounts that cannot be represented safely are not imported', () => {
    expect(classifyTrade(trade({ tokenAmount: '0' }))).toEqual({ kind: 'attention', reason: 'invalid_amounts' })
    expect(classifyTrade(trade({ tokenAmount: '1e5' }))).toEqual({ kind: 'attention', reason: 'invalid_amounts' })
    expect(classifyTrade(trade({ fiatAmount: '-5' }))).toEqual({ kind: 'attention', reason: 'invalid_amounts' })
  })
})

describe('the entry created for each side', () => {
  it('the buyer gets a BUY of the tokens for the PKR paid, dated at completion', () => {
    expect(toEventSpec(trade())).toEqual({
      sourceRef: 't1', assetKey: 'tok1', type: 'BUY', occurredAt: done, quantity: '100', consideration: '125000',
      quote: 'PKR', fxRate: null, note: 'Imported from RupChain trade CTM-1001',
    })
  })
  it('the seller gets a SELL for the same trade', () => {
    expect(toEventSpec(trade({ userId: 'seller' }))!.type).toBe('SELL')
  })
  it('someone who is neither party gets nothing', () => {
    expect(toEventSpec(trade({ userId: 'stranger' }))).toBeNull()
  })
  it('a USDT-paid trade is recorded in USDT with the rate implied by the trade itself', () => {
    const s = toEventSpec(trade({ paymentCurrency: 'USDT', usdtAmount: '446.42857143', fiatAmount: '125000.00' }))!
    expect(s.quote).toBe('USDT')
    expect(s.consideration).toBe('446.42857143')
    expect(s.fxRate).toBe('280')
  })
  it('a USDT trade with a missing USDT amount falls back to the PKR amount rather than guessing', () => {
    const s = toEventSpec(trade({ paymentCurrency: 'USDT', usdtAmount: null }))!
    expect(s.quote).toBe('PKR')
    expect(s.consideration).toBe('125000')
  })
  it('fractional token amounts stay exact', () => {
    expect(toEventSpec(trade({ tokenAmount: '0.00000001' }))!.quantity).toBe('0.00000001')
  })
})

describe('import plan (idempotent, read-only, reversible in analytics only)', () => {
  it('creates entries for eligible trades in date order and counts the rest as needing attention', () => {
    const plan = makePlan([
      trade({ id: 'b', completedAt: new Date('2026-10-02T00:00:00Z') }),
      trade({ id: 'a', completedAt: new Date('2026-10-01T00:00:00Z') }),
      trade({ id: 'd', status: 'disputed', completedAt: null }),
      trade({ id: 'e', status: 'buyer_confirming', completedAt: null }),
      trade({ id: 'x', status: 'cancelled', completedAt: null }),
    ], [])
    expect(plan.toCreate.map((s) => s.sourceRef)).toEqual(['a', 'b'])
    expect(plan.attention).toEqual([{ reason: 'disputed', count: 1 }, { reason: 'in_progress', count: 1 }])
  })
  it('running it again yields an empty plan', () => {
    const trades = [trade({ id: 'a' }), trade({ id: 'b' })]
    const plan = makePlan(trades, [{ id: 'e1', sourceRef: 'a', voidedAt: null }, { id: 'e2', sourceRef: 'b', voidedAt: null }])
    expect(plan).toMatchObject({ toCreate: [], toRestore: [], toVoid: [], alreadyImported: 2 })
  })
  it('an imported trade that stops qualifying is voided, not deleted', () => {
    const plan = makePlan([trade({ id: 'a', hasDispute: true })], [{ id: 'e1', sourceRef: 'a', voidedAt: null }])
    expect(plan.toVoid).toEqual([{ eventId: 'e1', reason: 'disputed' }])
    expect(plan.toCreate).toEqual([])
  })
  it('a voided entry is restored when its trade qualifies again, and not re-created', () => {
    const plan = makePlan([trade({ id: 'a' })], [{ id: 'e1', sourceRef: 'a', voidedAt: new Date() }])
    expect(plan.toRestore).toEqual(['e1'])
    expect(plan.toCreate).toEqual([])
  })
  it('an already-voided entry for a still-ineligible trade is left alone', () => {
    const plan = makePlan([trade({ id: 'a', hasDispute: true })], [{ id: 'e1', sourceRef: 'a', voidedAt: new Date() }])
    expect(plan.toVoid).toEqual([])
    expect(plan.toRestore).toEqual([])
  })
  it('an imported entry whose trade can no longer be found stops counting', () => {
    const plan = makePlan([], [{ id: 'e1', sourceRef: 'gone', voidedAt: null }])
    expect(plan.toVoid).toEqual([{ eventId: 'e1', reason: 'trade_missing' }])
  })
  it('a cancelled trade that had been imported is voided', () => {
    const plan = makePlan([trade({ id: 'a', status: 'cancelled', completedAt: null })], [{ id: 'e1', sourceRef: 'a', voidedAt: null }])
    expect(plan.toVoid).toHaveLength(1)
  })
  it('two partial fills stay two separate entries', () => {
    const plan = makePlan([trade({ id: 'f1', tokenAmount: '30' }), trade({ id: 'f2', tokenAmount: '70' })], [])
    expect(plan.toCreate.map((s) => [s.sourceRef, s.quantity])).toEqual([['f1', '30'], ['f2', '70']])
  })
})

describe('a trade the user already recorded by hand is never imported as well', () => {
  it('skips an eligible trade that has a manual linked record, and counts it', () => {
    const plan = makePlan([trade({ id: 'x' }), trade({ id: 'y' })], [], new Set(['x']))
    expect(plan.toCreate.map((s) => s.sourceRef)).toEqual(['y'])
    expect(plan.recordedManually).toBe(1)
  })
  it('without a link the trade is imported as before (and the link set is optional)', () => {
    const plan = makePlan([trade({ id: 'x' })], [])
    expect(plan.toCreate).toHaveLength(1)
    expect(plan.recordedManually).toBe(0)
  })
  it('a left-out trade the user recorded by hand no longer needs attention, but an unrecorded one still does', () => {
    const plan = makePlan([trade({ id: 'x', hasDispute: true }), trade({ id: 'y', hasDispute: true })], [], new Set(['x']))
    expect(plan.recordedManually).toBe(1)
    expect(plan.attention).toEqual([{ reason: 'disputed', count: 1 }])
    expect(plan.toCreate).toEqual([])
  })
  it('is idempotent: running the plan again with the same link set changes nothing', () => {
    const t = [trade({ id: 'x' })]
    expect(makePlan(t, [], new Set(['x'])).toCreate).toEqual(makePlan(t, [], new Set(['x'])).toCreate)
  })
})

describe('describeTrade (review list; never decides what counts)', () => {
  it('describes an unfinished or disputed trade from the user\'s side', () => {
    const d = describeTrade(trade({ status: 'disputed', completedAt: null }))!
    expect(d).toMatchObject({ side: 'BUY', quantity: '100', consideration: '125000', quote: 'PKR', fxRate: null })
    expect(describeTrade(trade({ userId: 'seller' }))!.side).toBe('SELL')
  })
  it('USDT-paid trades are shown in USDT with the implied rate', () => {
    expect(describeTrade(trade({ paymentCurrency: 'USDT', usdtAmount: '446.42857143' }))).toMatchObject({ quote: 'USDT', consideration: '446.42857143', fxRate: '280' })
  })
  it('returns null for a stranger or an unusable token amount, and no amount for a bad fiat amount', () => {
    expect(describeTrade(trade({ userId: 'stranger' }))).toBeNull()
    expect(describeTrade(trade({ tokenAmount: '0' }))).toBeNull()
    expect(describeTrade(trade({ fiatAmount: '-1' }))!.consideration).toBeNull()
  })
})
