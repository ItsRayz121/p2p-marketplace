import { describe, it, expect } from 'vitest'
import {
  acceptsClaims, assertDecision, assertEvidence, buildSnapshot, canResubmit, cleanAttachments, cleanLinks,
  dayBuckets, isReviewable, median, nextStatus, taskLifecycle, waitingHours, RuleError,
} from '../platformTask.rules'

const now = new Date('2026-10-10T12:00:00Z')
const task = (o: Partial<Parameters<typeof taskLifecycle>[0]> = {}) => ({ isDraft: false, archivedAt: null, isActive: true, startsAt: null, endsAt: null, ...o })
const good = { url: 'https://res.cloudinary.com/demo/image/authenticated/v1/rupchain/task-proof/abc.png', name: 'shot.png', size: 1000, mime: 'image/png' }

describe('taskLifecycle', () => {
  it('derives every state and only "active" accepts claims', () => {
    expect(taskLifecycle(task(), now)).toBe('active')
    expect(taskLifecycle(task({ isActive: false }), now)).toBe('paused')
    expect(taskLifecycle(task({ isDraft: true }), now)).toBe('draft')
    expect(taskLifecycle(task({ archivedAt: now }), now)).toBe('archived')
    expect(taskLifecycle(task({ startsAt: new Date('2026-11-01') }), now)).toBe('scheduled')
    expect(taskLifecycle(task({ endsAt: new Date('2026-10-01') }), now)).toBe('ended')
    for (const l of ['draft', 'scheduled', 'paused', 'ended', 'archived'] as const) expect(acceptsClaims(l)).toBe(false)
    expect(acceptsClaims('active')).toBe(true)
  })
  it('archived wins over everything and draft over paused', () => {
    expect(taskLifecycle(task({ archivedAt: now, isDraft: true, isActive: false }), now)).toBe('archived')
    expect(taskLifecycle(task({ isDraft: true, isActive: false }), now)).toBe('draft')
  })
})

describe('cleanLinks', () => {
  it('keeps https links, dedupes and trims', () => {
    expect(cleanLinks([' https://x.com/a ', 'https://x.com/a', ''])).toEqual(['https://x.com/a'])
  })
  it('rejects http, javascript:, non-strings and too many', () => {
    expect(() => cleanLinks(['http://x.com'])).toThrow(RuleError)
    expect(() => cleanLinks(['javascript:alert(1)'])).toThrow(RuleError)
    expect(() => cleanLinks([5 as unknown as string])).toThrow(RuleError)
    expect(() => cleanLinks(['https://a.co/1', 'https://a.co/2', 'https://a.co/3', 'https://a.co/4'])).toThrow(RuleError)
  })
})

describe('cleanAttachments', () => {
  it('accepts our private proof uploads', () => {
    expect(cleanAttachments([good])).toHaveLength(1)
  })
  it('rejects foreign hosts, wrong folders, bad types and oversize files', () => {
    expect(() => cleanAttachments([{ ...good, url: 'https://evil.example/rupchain/task-proof/x.png' }])).toThrow(RuleError)
    expect(() => cleanAttachments([{ ...good, url: 'https://res.cloudinary.com/demo/image/upload/v1/rupchain/avatars/x.png' }])).toThrow(RuleError)
    expect(() => cleanAttachments([{ ...good, mime: 'text/html' }])).toThrow(RuleError)
    expect(() => cleanAttachments([{ ...good, size: 11 * 1024 * 1024 }])).toThrow(RuleError)
    expect(() => cleanAttachments([good, good, good, good, good])).toThrow(RuleError)
  })
  it('sanitises file names', () => {
    expect(cleanAttachments([{ ...good, name: '<script>x.png' }])[0]!.name).not.toContain('<')
  })
})

describe('assertEvidence', () => {
  const ev = { proof: '', links: [] as string[], attachments: [] as ReturnType<typeof cleanAttachments> }
  it('manual review needs something to review', () => {
    expect(() => assertEvidence({ verifyMode: 'manual_proof', proofFileRequired: false }, ev)).toThrow(RuleError)
    expect(() => assertEvidence({ verifyMode: 'manual_proof', proofFileRequired: false }, { ...ev, proof: '@me' })).not.toThrow()
  })
  it('requires a file when the task demands one', () => {
    expect(() => assertEvidence({ verifyMode: 'manual_proof', proofFileRequired: true }, { ...ev, proof: '@me' })).toThrow(RuleError)
    expect(() => assertEvidence({ verifyMode: 'manual_proof', proofFileRequired: true }, { ...ev, attachments: [good] })).not.toThrow()
  })
  it('does nothing for automatic verification', () => {
    expect(() => assertEvidence({ verifyMode: 'telegram_auto', proofFileRequired: false }, ev)).not.toThrow()
  })
})

describe('decisions', () => {
  it('feedback is mandatory to reject or request changes, not to approve', () => {
    expect(() => assertDecision({ decision: 'approve' })).not.toThrow()
    expect(() => assertDecision({ decision: 'reject', feedback: '   ' })).toThrow(RuleError)
    expect(() => assertDecision({ decision: 'request_changes', feedback: 'no' })).toThrow(RuleError)
    expect(() => assertDecision({ decision: 'request_changes', feedback: 'Please show your username.' })).not.toThrow()
    expect(() => assertDecision({ decision: 'reject', feedback: 'x'.repeat(1001) })).toThrow(RuleError)
  })
  it('maps decisions to statuses, and approval never means "paid"', () => {
    expect(nextStatus('approve', 'awaiting_payout')).toBe('awaiting_payout')
    expect(nextStatus('approve', 'completed')).toBe('completed')
    expect(nextStatus('reject', 'completed')).toBe('rejected')
    expect(nextStatus('request_changes', 'completed')).toBe('needs_changes')
  })
  it('only needs_changes can be resubmitted and only pending_review reviewed', () => {
    expect(canResubmit('needs_changes')).toBe(true)
    for (const s of ['pending_review', 'completed', 'rejected', 'awaiting_payout']) expect(canResubmit(s)).toBe(false)
    expect(isReviewable('pending_review')).toBe(true)
    for (const s of ['needs_changes', 'completed', 'rejected', 'awaiting_payout']) expect(isReviewable(s)).toBe(false)
  })
})

describe('helpers', () => {
  it('waitingHours is never negative', () => {
    expect(waitingHours(new Date('2026-10-10T10:00:00Z'), now)).toBe(2)
    expect(waitingHours(new Date('2026-10-10T14:00:00Z'), now)).toBe(0)
  })
  it('median handles empty, odd and even lists', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  it('dayBuckets is zero-fill continuous and capped', () => {
    expect(dayBuckets(new Date('2026-10-08T23:00:00Z'), new Date('2026-10-10T01:00:00Z'))).toEqual(['2026-10-08', '2026-10-09', '2026-10-10'])
    expect(dayBuckets(new Date('2020-01-01'), new Date('2026-01-01'), 30)).toHaveLength(30)
  })
  it('snapshot freezes the terms', () => {
    const s = buildSnapshot({ title: 'T', instructions: 'i', proofRequirements: null, proofFileRequired: false, verifyMode: 'manual_proof', rewardType: 'usdt', rewardPoints: null, rewardUsdt: '2.5', payoutMode: 'manual', version: 3 })
    expect(s).toMatchObject({ rewardUsdt: '2.5', version: 3, payoutMode: 'manual' })
  })
})

import { parsePeriod, paymentState } from '../platformTask.rules'

describe('paymentState', () => {
  it('approval of a manual USDT claim is awaiting payment, never paid', () => {
    expect(paymentState({ rewardType: 'usdt', payoutMode: 'manual', status: 'awaiting_payout', txHash: null })).toBe('awaiting_payment')
  })
  it('an awaiting claim shows processing or failed from the send attempt, and a null attempt stays awaiting', () => {
    const base = { rewardType: 'usdt', payoutMode: 'manual', status: 'awaiting_payout', txHash: null }
    expect(paymentState({ ...base, payoutAttempt: 'processing' })).toBe('processing')
    expect(paymentState({ ...base, payoutAttempt: 'failed' })).toBe('failed')
    expect(paymentState({ ...base, payoutAttempt: null })).toBe('awaiting_payment')
  })
  it('a leftover attempt marker never changes a settled claim', () => {
    expect(paymentState({ rewardType: 'usdt', payoutMode: 'manual', status: 'completed', txHash: '0xabc', payoutAttempt: 'failed' })).toBe('paid')
  })
  it('only a recorded tx hash (or automatic wallet credit) counts as settled', () => {
    expect(paymentState({ rewardType: 'usdt', payoutMode: 'manual', status: 'completed', txHash: '0xabc' })).toBe('paid')
    expect(paymentState({ rewardType: 'usdt', payoutMode: 'auto', status: 'completed', txHash: null })).toBe('credited')
    expect(paymentState({ rewardType: 'points', payoutMode: null, status: 'completed', txHash: null })).toBe('credited')
  })
})

describe('parsePeriod', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  it('defaults to the last 30 days', () => {
    const p = parsePeriod(undefined, undefined, now)
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 86_400_000)).toBe(29)
  })
  it('ignores garbage and inverted ranges and caps the span at a year', () => {
    expect(parsePeriod('nope', 'also nope', now).to).toEqual(now)
    const inverted = parsePeriod('2026-10-09', '2026-10-01', now)
    expect(inverted.from <= inverted.to).toBe(true)
    const huge = parsePeriod('2000-01-01', '2026-10-01', now)
    expect((huge.to.getTime() - huge.from.getTime()) / 86_400_000).toBeLessThanOrEqual(366)
  })
})
