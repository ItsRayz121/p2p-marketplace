import { describe, it, expect } from 'vitest'
import {
  ladderStatus, isResumingUnderDispute, advanceTo, claimRung, assertPartySettleable,
} from '../disputeResume'
import { AppError } from '../../lib/errors'

const live = { status: 'payment_uploaded' as const, disputeResumeStatus: null }
const disputed = { status: 'disputed' as const, disputeResumeStatus: 'payment_uploaded' }
const frozen = { status: 'disputed' as const, disputeResumeStatus: null }

describe('disputeResume — undisputed trades are byte-identical to before', () => {
  it('reports the raw status as the ladder rung', () => {
    expect(ladderStatus(live)).toBe('payment_uploaded')
    expect(isResumingUnderDispute(live)).toBe(false)
  })

  it('advances and claims with a plain status, no extra column', () => {
    expect(advanceTo(live, 'payment_confirmed')).toEqual({ status: 'payment_confirmed' })
    expect(claimRung(live, 'payment_uploaded')).toEqual({ status: 'payment_uploaded' })
  })

  it('never gates an undisputed trade, even with no dispute record', () => {
    expect(() => assertPartySettleable(live, null)).not.toThrow()
  })
})

describe('disputeResume — a disputed trade keeps its real rung', () => {
  it('reads the rung out of disputeResumeStatus', () => {
    expect(ladderStatus(disputed)).toBe('payment_uploaded')
    expect(isResumingUnderDispute(disputed)).toBe(true)
  })

  it('advances the rung while `status` stays parked at disputed', () => {
    expect(advanceTo(disputed, 'payment_confirmed')).toEqual({
      status: 'disputed', disputeResumeStatus: 'payment_confirmed',
    })
  })

  it('CAS-claims on the rung, not the parked status', () => {
    expect(claimRung(disputed, 'payment_uploaded')).toEqual({
      status: 'disputed', disputeResumeStatus: 'payment_uploaded',
    })
  })

  it('THE INVARIANT: only a terminal advance leaves `disputed`', () => {
    // Any non-terminal action by the accused keeps the trade disputed…
    expect(advanceTo(disputed, 'crypto_sent').status).toBe('disputed')
    // …and only completing actually clears it, which is what closes the dispute.
    expect(advanceTo(disputed, 'crypto_released', { terminal: true })).toEqual({
      status: 'crypto_released', disputeResumeStatus: null,
    })
  })
})

describe('disputeResume — admin override always wins', () => {
  it('allows party settlement only while the dispute is untouched', () => {
    expect(() => assertPartySettleable(disputed, { status: 'open' })).not.toThrow()
  })

  it('freezes the ladder once an admin has taken the case', () => {
    for (const status of ['under_review', 'escalated', 'awaiting_evidence', 'resolved']) {
      expect(() => assertPartySettleable(disputed, { status })).toThrow(AppError)
    }
  })

  it('freezes a legacy disputed trade whose rung was never recorded', () => {
    expect(() => assertPartySettleable(frozen, { status: 'open' })).toThrow(AppError)
  })

  it('freezes when the dispute record is missing entirely', () => {
    expect(() => assertPartySettleable(disputed, null)).toThrow(AppError)
  })
})
