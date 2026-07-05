import { describe, it, expect } from 'vitest'
import {
  flowSteps, stepForAction, stepFromStatus, actorForAction, isTerminalAction, statusMeaning,
  STATUS_LADDER,
} from '../settlementFlow'

describe('settlementFlow — classic (fiat-first)', () => {
  const steps = flowSteps(false)

  it('has four steps climbing the status ladder', () => {
    expect(steps.map((s) => s.from)).toEqual(['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'])
    expect(steps.map((s) => s.to)).toEqual(['payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released'])
  })

  it('orders actions fiat-first: buyer pays, seller confirms, seller sends crypto, buyer confirms', () => {
    expect(steps.map((s) => s.action)).toEqual(['send_fiat', 'confirm_fiat', 'send_crypto', 'confirm_crypto'])
    expect(steps.map((s) => s.actor)).toEqual(['buyer', 'seller', 'seller', 'buyer'])
  })

  it('is terminal only on the final confirm_crypto (crypto_released)', () => {
    expect(steps.filter((s) => s.terminal).map((s) => s.action)).toEqual(['confirm_crypto'])
    expect(isTerminalAction(false, 'confirm_crypto')).toBe(true)
    expect(isTerminalAction(false, 'send_crypto')).toBe(false)
  })

  it('send_crypto transitions payment_confirmed → crypto_sent (verification step)', () => {
    const s = stepForAction(false, 'send_crypto')
    expect(s.from).toBe('payment_confirmed')
    expect(s.to).toBe('crypto_sent')
  })
})

describe('settlementFlow — taker-first (BUY ad reordered)', () => {
  const steps = flowSteps(true)

  it('climbs the same status ladder', () => {
    expect(steps.map((s) => s.from)).toEqual(['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'])
    expect(steps.map((s) => s.to)).toEqual(['payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released'])
  })

  it('orders actions crypto-first: taker sends crypto, maker confirms, maker pays fiat, taker confirms', () => {
    expect(steps.map((s) => s.action)).toEqual(['send_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat'])
    // Actors are INVARIANT — still seller sends crypto / buyer confirms / buyer pays / seller confirms.
    expect(steps.map((s) => s.actor)).toEqual(['seller', 'buyer', 'buyer', 'seller'])
  })

  it('moves the verification step (send_crypto) to the FIRST transition', () => {
    const s = stepForAction(true, 'send_crypto')
    expect(s.from).toBe('payment_pending')
    expect(s.to).toBe('payment_uploaded')
  })

  it('makes confirm_fiat terminal (not confirm_crypto)', () => {
    expect(isTerminalAction(true, 'confirm_fiat')).toBe(true)
    expect(isTerminalAction(true, 'confirm_crypto')).toBe(false)
    expect(stepForAction(true, 'confirm_fiat').to).toBe('crypto_released')
  })
})

describe('settlementFlow — invariants across both flows', () => {
  it('actor per action never changes with flow', () => {
    for (const action of ['send_fiat', 'confirm_fiat', 'send_crypto', 'confirm_crypto'] as const) {
      expect(stepForAction(false, action).actor).toBe(actorForAction(action))
      expect(stepForAction(true, action).actor).toBe(actorForAction(action))
    }
    expect(actorForAction('send_fiat')).toBe('buyer')
    expect(actorForAction('send_crypto')).toBe('seller')
    expect(actorForAction('confirm_fiat')).toBe('seller')
    expect(actorForAction('confirm_crypto')).toBe('buyer')
  })

  it('every non-terminal status resolves to exactly one outgoing step', () => {
    for (const takerFirst of [false, true]) {
      for (const status of STATUS_LADDER.slice(0, 4)) {
        expect(stepFromStatus(takerFirst, status)?.from).toBe(status)
      }
      // Terminal status has no outgoing step.
      expect(stepFromStatus(takerFirst, 'crypto_released')).toBeUndefined()
    }
  })

  it('statusMeaning reports who the flow is waiting on', () => {
    // Classic: at payment_pending we wait on the buyer to pay fiat.
    expect(statusMeaning(false, 'payment_pending')).toEqual({ waitingOn: 'buyer', action: 'send_fiat' })
    // Taker-first: at payment_pending we wait on the seller (taker) to send crypto.
    expect(statusMeaning(true, 'payment_pending')).toEqual({ waitingOn: 'seller', action: 'send_crypto' })
  })
})
