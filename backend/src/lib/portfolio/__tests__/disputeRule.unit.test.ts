import { describe, it, expect } from 'vitest'
import { disputeBlocksImport } from '../disputeRule'

describe('when a dispute keeps a trade out of the portfolio', () => {
  it('no dispute never blocks', () => {
    expect(disputeBlocksImport(null)).toBe(false)
    expect(disputeBlocksImport(undefined)).toBe(false)
  })
  it('an open dispute blocks until it is resolved, whatever stage it is at', () => {
    for (const status of ['open', 'under_review', 'escalated', 'awaiting_evidence']) {
      expect(disputeBlocksImport({ status, resolutionType: null })).toBe(true)
    }
  })
  it('an admin ruling blocks: it does not prove the exchange happened', () => {
    for (const resolutionType of ['buyer_wins', 'seller_wins', 'split']) {
      expect(disputeBlocksImport({ status: 'resolved', resolutionType })).toBe(true)
    }
  })
  it('a no-fault close (settled by the parties, or dismissed) lets the trade count once it is complete', () => {
    expect(disputeBlocksImport({ status: 'resolved', resolutionType: 'settled_by_parties' })).toBe(false)
    expect(disputeBlocksImport({ status: 'resolved', resolutionType: 'dismissed' })).toBe(false)
  })
  it('a dispute with missing details is treated as blocking, never as harmless', () => {
    expect(disputeBlocksImport({})).toBe(true)
    expect(disputeBlocksImport({ status: 'resolved', resolutionType: null })).toBe(true)
  })
})
