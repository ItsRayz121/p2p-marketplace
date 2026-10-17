import { describe, it, expect } from 'vitest'
import { approvalBlock, currentItems, itemsOf, settleStatus, waitingOnApplicant, type SubmissionShape } from '../kycItems'

const sub = (o: Partial<SubmissionShape> = {}): SubmissionShape => ({
  tier: 'enhanced', idType: 'national_id', backUrl: 'b', legalName: 'Ali Khan', socialLinks: [{ platform: 'facebook', url: 'https://f' }],
  whatsappNumber: '+923001234567', communityLinks: [{ url: 'https://chat.whatsapp.com/x' }], referenceUrl: null, ...o,
})
const at = (n: number) => new Date(2026, 9, 17, 10, n)

describe('which parts a submission has', () => {
  it('lists the identity items and the Enhanced answers', () => {
    expect(itemsOf(sub())).toEqual(['id_front', 'id_back', 'selfie', 'legal_name', 'social', 'whatsapp', 'community'])
  })
  it('has no ID back for a passport, no social/name when absent, and a reference only when given', () => {
    expect(itemsOf(sub({ idType: 'passport', legalName: null, socialLinks: [], referenceUrl: 'https://r' }))).toEqual(['id_front', 'selfie', 'whatsapp', 'community', 'reference'])
  })
  it('a Basic submission has no Enhanced items', () => {
    expect(itemsOf(sub({ tier: 'basic' }))).not.toContain('whatsapp')
  })
})

describe('the latest decision per item wins', () => {
  it('an item with no event is pending; a resubmission supersedes the flag', () => {
    const items = itemsOf(sub())
    const cur = currentItems(items, [
      { item: 'selfie', status: 'resubmit', reason: 'blurry', createdAt: at(1) },
      { item: 'id_front', status: 'approved', reason: null, createdAt: at(2) },
      { item: 'selfie', status: 'resubmitted', reason: null, createdAt: at(3) },
    ])
    expect(cur.find((i) => i.item === 'selfie')!.status).toBe('resubmitted')
    expect(cur.find((i) => i.item === 'id_front')!.status).toBe('approved')
    expect(cur.find((i) => i.item === 'whatsapp')!.status).toBe('pending')
  })
  it('does not depend on the order the rows arrive in', () => {
    const cur = currentItems(['selfie'], [
      { item: 'selfie', status: 'resubmitted', reason: null, createdAt: at(3) },
      { item: 'selfie', status: 'resubmit', reason: 'x', createdAt: at(1) },
    ])
    expect(cur[0]!.status).toBe('resubmitted')
  })
})

describe('settling the two parts', () => {
  it('stays pending while either part is open, including waiting for the applicant', () => {
    expect(settleStatus({ basicState: 'approved', enhancedState: 'pending' })).toBe('pending')
    expect(settleStatus({ basicState: 'approved', enhancedState: 'changes_requested' })).toBe('pending')
    expect(settleStatus({ basicState: 'changes_requested', enhancedState: 'not_requested' })).toBe('pending')
  })
  it('is approved once Basic is approved and nothing else is open, even if Enhanced was rejected', () => {
    expect(settleStatus({ basicState: 'approved', enhancedState: 'not_requested' })).toBe('approved')
    expect(settleStatus({ basicState: 'approved', enhancedState: 'approved' })).toBe('approved')
    expect(settleStatus({ basicState: 'approved', enhancedState: 'rejected' })).toBe('approved')
  })
  it('is rejected when Basic is rejected', () => {
    expect(settleStatus({ basicState: 'rejected', enhancedState: 'rejected' })).toBe('rejected')
  })
  it('knows when only the applicant can move it forward', () => {
    expect(waitingOnApplicant({ basicState: 'approved', enhancedState: 'changes_requested' })).toBe(true)
    expect(waitingOnApplicant({ basicState: 'pending', enhancedState: 'changes_requested' })).toBe(false)
    expect(waitingOnApplicant({ basicState: 'approved', enhancedState: 'pending' })).toBe(false)
  })
})

describe('what may be approved', () => {
  const items = (flag?: string) => itemsOf(sub()).map((item) => ({ item, part: item === 'whatsapp' || item === 'community' ? ('enhanced' as const) : ('basic' as const), status: item === flag ? ('resubmit' as const) : ('pending' as const) }))
  it('Basic can be approved while Enhanced has a problem', () => {
    expect(approvalBlock('basic', { basicState: 'pending', enhancedState: 'pending' }, items('community'))).toBeNull()
  })
  it('Enhanced cannot be approved before Basic, nor with a flagged item', () => {
    expect(approvalBlock('enhanced', { basicState: 'pending', enhancedState: 'pending' }, items())).toMatch(/Approve Basic first/)
    expect(approvalBlock('enhanced', { basicState: 'approved', enhancedState: 'pending' }, items('community'))).toMatch(/Community link/)
  })
  it('a flagged identity item blocks Basic', () => {
    expect(approvalBlock('basic', { basicState: 'pending', enhancedState: 'pending' }, items('selfie'))).toMatch(/Selfie/)
  })
  it('decided or unrequested parts cannot be approved again', () => {
    expect(approvalBlock('basic', { basicState: 'approved', enhancedState: 'pending' }, items())).toMatch(/already approved/)
    expect(approvalBlock('enhanced', { basicState: 'approved', enhancedState: 'not_requested' }, items())).toMatch(/did not apply/)
  })
})
