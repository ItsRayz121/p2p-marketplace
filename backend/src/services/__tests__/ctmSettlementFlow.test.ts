import { describe, it, expect } from 'vitest'
import {
  ctmFlowSteps, ctmStepForAction, ctmStepFromStatus, ctmActorForAction,
  ctmIsTerminalAction, ctmStatusMeaning, ctmDisputeLock, CTM_STATUS_LADDER,
  ctmResumeDeadline,
} from '../ctmSettlementFlow'

describe('ctmSettlementFlow — classic (fiat-first)', () => {
  const steps = ctmFlowSteps(false)

  it('has five steps climbing the six-rung status ladder', () => {
    expect(steps.map((s) => s.from)).toEqual([
      'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted',
    ])
    expect(steps.map((s) => s.to)).toEqual([
      'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed',
    ])
  })

  it('orders actions fiat-first: buyer pays, seller confirms, seller sends (2 steps), buyer confirms', () => {
    expect(steps.map((s) => s.action)).toEqual(['send_fiat', 'confirm_fiat', 'start_crypto', 'prove_crypto', 'confirm_crypto'])
    expect(steps.map((s) => s.actor)).toEqual(['buyer', 'seller', 'seller', 'seller', 'buyer'])
  })

  it('is terminal only on the final confirm_crypto (→ completed)', () => {
    expect(steps.filter((s) => s.terminal).map((s) => s.action)).toEqual(['confirm_crypto'])
    expect(ctmIsTerminalAction(false, 'confirm_crypto')).toBe(true)
    expect(ctmIsTerminalAction(false, 'confirm_fiat')).toBe(false)
    expect(ctmStepForAction(false, 'confirm_crypto').to).toBe('completed')
  })

  it('matches the current hardcoded transition endpoints exactly', () => {
    expect(ctmStepForAction(false, 'send_fiat')).toMatchObject({ from: 'awaiting_payment', to: 'payment_uploaded' })
    expect(ctmStepForAction(false, 'confirm_fiat')).toMatchObject({ from: 'payment_uploaded', to: 'payment_confirmed' })
    expect(ctmStepForAction(false, 'start_crypto')).toMatchObject({ from: 'payment_confirmed', to: 'seller_transferring' })
    expect(ctmStepForAction(false, 'prove_crypto')).toMatchObject({ from: 'seller_transferring', to: 'proof_submitted' })
    expect(ctmStepForAction(false, 'confirm_crypto')).toMatchObject({ from: 'proof_submitted', to: 'completed' })
  })
})

describe('ctmSettlementFlow — taker-first (BUY listing reordered)', () => {
  const steps = ctmFlowSteps(true)

  it('climbs the same six-rung status ladder', () => {
    expect(steps.map((s) => s.from)).toEqual([
      'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted',
    ])
    expect(steps.map((s) => s.to)).toEqual([
      'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed',
    ])
  })

  it('orders actions crypto-first: taker sends (2 steps), maker confirms, maker pays, taker confirms', () => {
    expect(steps.map((s) => s.action)).toEqual(['start_crypto', 'prove_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat'])
    // Actors INVARIANT — still seller sends crypto / buyer confirms / buyer pays / seller confirms.
    expect(steps.map((s) => s.actor)).toEqual(['seller', 'seller', 'buyer', 'buyer', 'seller'])
  })

  it('moves the crypto-send steps to the FRONT of the ladder', () => {
    expect(ctmStepForAction(true, 'start_crypto')).toMatchObject({ from: 'awaiting_payment', to: 'payment_uploaded' })
    expect(ctmStepForAction(true, 'prove_crypto')).toMatchObject({ from: 'payment_uploaded', to: 'payment_confirmed' })
  })

  it('makes confirm_fiat terminal (not confirm_crypto), both landing on proof_submitted → completed', () => {
    expect(ctmIsTerminalAction(true, 'confirm_fiat')).toBe(true)
    expect(ctmIsTerminalAction(true, 'confirm_crypto')).toBe(false)
    expect(ctmStepForAction(true, 'confirm_fiat')).toMatchObject({ from: 'proof_submitted', to: 'completed' })
  })
})

describe('ctmSettlementFlow — terminal step is the same rung in both flows', () => {
  it('always transitions proof_submitted → completed regardless of flow', () => {
    for (const takerFirst of [false, true]) {
      const terminal = ctmFlowSteps(takerFirst).find((s) => s.terminal)!
      expect(terminal.from).toBe('proof_submitted')
      expect(terminal.to).toBe('completed')
    }
  })
})

describe('ctmSettlementFlow — dispute lock', () => {
  it('classic: locks the seller from payment_confirmed onward', () => {
    const lock = ctmDisputeLock(false)
    expect(lock.actor).toBe('seller')
    expect(lock.lockedStatuses).toEqual(['payment_confirmed', 'seller_transferring', 'proof_submitted'])
  })

  it('taker-first: locks the buyer/maker from seller_transferring onward', () => {
    const lock = ctmDisputeLock(true)
    expect(lock.actor).toBe('buyer')
    expect(lock.lockedStatuses).toEqual(['seller_transferring', 'proof_submitted'])
  })
})

describe('ctmSettlementFlow — invariants across both flows', () => {
  it('actor per action never changes with flow', () => {
    for (const action of ['send_fiat', 'confirm_fiat', 'start_crypto', 'prove_crypto', 'confirm_crypto'] as const) {
      expect(ctmStepForAction(false, action).actor).toBe(ctmActorForAction(action))
      expect(ctmStepForAction(true, action).actor).toBe(ctmActorForAction(action))
    }
    expect(ctmActorForAction('send_fiat')).toBe('buyer')
    expect(ctmActorForAction('confirm_fiat')).toBe('seller')
    expect(ctmActorForAction('start_crypto')).toBe('seller')
    expect(ctmActorForAction('prove_crypto')).toBe('seller')
    expect(ctmActorForAction('confirm_crypto')).toBe('buyer')
  })

  it('every non-terminal status resolves to exactly one outgoing step', () => {
    for (const takerFirst of [false, true]) {
      for (const status of CTM_STATUS_LADDER.slice(0, 5)) {
        expect(ctmStepFromStatus(takerFirst, status)?.from).toBe(status)
      }
      expect(ctmStepFromStatus(takerFirst, 'completed')).toBeUndefined()
    }
  })

  it('statusMeaning reports who the flow is waiting on', () => {
    // Classic: at awaiting_payment we wait on the buyer to pay fiat.
    expect(ctmStatusMeaning(false, 'awaiting_payment')).toEqual({ waitingOn: 'buyer', action: 'send_fiat' })
    // Taker-first: at awaiting_payment we wait on the seller (taker) to start the crypto transfer.
    expect(ctmStatusMeaning(true, 'awaiting_payment')).toEqual({ waitingOn: 'seller', action: 'start_crypto' })
  })
})

describe('ctmResumeDeadline', () => {
  it('never arms a deadline for awaiting_payment or completed, in either flow', () => {
    for (const takerFirst of [false, true]) {
      expect(ctmResumeDeadline(takerFirst, 'awaiting_payment')).toEqual({})
      expect(ctmResumeDeadline(takerFirst, 'completed')).toEqual({})
    }
  })

  it('classic: arms proofDeadlineAt for the pending action at every non-terminal rung', () => {
    expect(ctmResumeDeadline(false, 'payment_uploaded')).toHaveProperty('proofDeadlineAt') // pending: confirm_fiat
    expect(ctmResumeDeadline(false, 'payment_confirmed')).toHaveProperty('proofDeadlineAt') // pending: start_crypto
    expect(ctmResumeDeadline(false, 'seller_transferring')).toHaveProperty('proofDeadlineAt') // pending: prove_crypto
    // proof_submitted's pending action (confirm_crypto) is the terminal step, so it uses confirmDeadlineAt.
    expect(ctmResumeDeadline(false, 'proof_submitted')).toHaveProperty('confirmDeadlineAt')
    expect(ctmResumeDeadline(false, 'proof_submitted')).not.toHaveProperty('proofDeadlineAt')
  })

  it('taker-first: payment_confirmed is a different pending action than classic (confirm_crypto, not start_crypto) and uses confirmDeadlineAt', () => {
    const classic = ctmResumeDeadline(false, 'payment_confirmed')
    const takerFirst = ctmResumeDeadline(true, 'payment_confirmed')
    expect(classic).toHaveProperty('proofDeadlineAt')
    expect(takerFirst).toHaveProperty('confirmDeadlineAt')
    expect(takerFirst).not.toHaveProperty('proofDeadlineAt')
  })

  it('returns a future timestamp, not a past or null one', () => {
    const now = Date.now()
    const patch = ctmResumeDeadline(false, 'payment_confirmed')
    const value = patch.proofDeadlineAt ?? patch.confirmDeadlineAt
    expect(value).toBeInstanceOf(Date)
    expect(value!.getTime()).toBeGreaterThan(now)
  })
})
