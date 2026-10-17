import { describe, it, expect } from 'vitest'
import { disputeBlocksImport, disputeKind } from '../disputeRule'

const at = new Date('2026-10-05T00:00:00Z')

describe('what a dispute means for a trade in the portfolio', () => {
  it('no dispute is nothing special', () => {
    expect(disputeKind(null)).toBe('none')
    expect(disputeBlocksImport(undefined)).toBe(false)
  })
  it('an open dispute keeps the trade out, at every stage, until it is resolved', () => {
    for (const status of ['open', 'under_review', 'escalated', 'awaiting_evidence']) {
      expect(disputeKind({ status, resolutionType: null })).toBe('blocked')
      expect(disputeBlocksImport({ status })).toBe(true)
    }
  })
  it('once resolved, the ruling decides: buyer wins counts, seller wins means nothing was exchanged', () => {
    expect(disputeKind({ status: 'resolved', resolutionType: 'buyer_wins', resolvedAt: at })).toBe('buyer_wins')
    expect(disputeKind({ status: 'resolved', resolutionType: 'seller_wins', resolvedAt: at })).toBe('seller_wins')
    expect(disputeBlocksImport({ status: 'resolved', resolutionType: 'buyer_wins', resolvedAt: at })).toBe(false)
  })
  it('a split cannot be added automatically: the agreed amounts are not recorded', () => {
    expect(disputeKind({ status: 'resolved', resolutionType: 'split', resolvedAt: at })).toBe('blocked')
  })
  it('a no-fault close (settled by the parties, or dismissed) is nothing special', () => {
    expect(disputeKind({ status: 'resolved', resolutionType: 'settled_by_parties' })).toBe('none')
    expect(disputeKind({ status: 'resolved', resolutionType: 'dismissed' })).toBe('none')
  })
  it('a dispute with missing details is treated as blocking, never as harmless', () => {
    expect(disputeKind({})).toBe('blocked')
    expect(disputeKind({ status: 'resolved', resolutionType: null })).toBe('blocked')
    expect(disputeKind({ status: 'resolved', resolutionType: 'buyer_wins' })).toBe('blocked') // no ruling date
  })
})
