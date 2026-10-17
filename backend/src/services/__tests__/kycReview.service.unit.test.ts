import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
const st = vi.hoisted(() => ({
  sub: {} as Row,
  events: [] as Row[],
  user: {} as Row,
  userUpdates: [] as Row[],
  audits: [] as Row[],
  clock: 0,
  conflictHash: false,
  notify: vi.fn(),
  email: vi.fn(),
  adminNotif: vi.fn(),
  maker: vi.fn(),
  merge: vi.fn(),
  incr: 0,
}))

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as Row).in as unknown[]).includes(row[k])
    return row[k] === v
  })

vi.mock('../../lib/prisma', () => {
  const db: Row = {
    kycSubmission: {
      findUnique: async () => ({ ...st.sub, user: { email: 'a@b.c', kycLevel: st.user.kycLevel } }),
      findFirst: async () => (st.conflictHash ? { userId: 'other', user: { username: 'zed', email: null } } : null),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(st.sub, where)) return { count: 0 }
        Object.assign(st.sub, data)
        return { count: 1 }
      },
    },
    kycItemReview: {
      findMany: async () => st.events.map((e) => ({ ...e })),
      create: async ({ data }: { data: Row }) => { st.events.push({ ...data, createdAt: new Date(2026, 9, 17, 10, ++st.clock) }) },
      createMany: async ({ data }: { data: Row[] }) => { for (const d of data) st.events.push({ ...d, reason: d.reason ?? null, createdAt: new Date(2026, 9, 17, 10, ++st.clock) }) },
    },
    user: { update: async ({ data }: { data: Row }) => { st.userUpdates.push(data); Object.assign(st.user, data) } },
    auditLog: { create: async ({ data }: { data: Row }) => { st.audits.push(data) } },
  }
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db)
  return { db }
})
vi.mock('../../lib/redis', () => ({ redis: { incr: async () => ++st.incr, expire: async () => 1 } }))
vi.mock('../../lib/notify', () => ({ notify: st.notify }))
vi.mock('../email.service', () => ({ sendKycEmail: st.email }))
vi.mock('../adminNotification.service', () => ({ createAdminNotif: st.adminNotif }))
vi.mock('../marketplace.service', () => ({ getPublicConfig: async () => ({ kycLimitBasicDaily: 50000, kycLimitEnhancedDaily: 500000 }) }))
vi.mock('../platformFlags.service', () => ({ FLAGS: { NONCUSTODIAL_P2P: 'n' }, isFlagEnabled: async () => false }))
vi.mock('../maker.service', () => ({ approveMakerFromKyc: st.maker }))
vi.mock('../socialLinks.service', () => ({ mergeVerifiedFromKyc: st.merge }))
vi.mock('../../lib/upload', () => ({ assertCloudinaryUrl: (u: string) => { if (!u.startsWith('https://res.cloudinary.com/')) throw new Error('bad url') } }))

import { approvePart, recordItemDecision, rejectPart, requestChanges, resubmitItems, reviewState } from '../kycReview.service'

const ADMIN = { id: 'admin1' }
const sub = (o: Row = {}): Row => ({
  id: 's1', userId: 'u1', status: 'pending', tier: 'enhanced', idType: 'national_id', frontUrl: 'https://res.cloudinary.com/f1', backUrl: 'https://res.cloudinary.com/b1',
  selfieUrl: 'https://res.cloudinary.com/s1', legalName: 'Ali Khan', socialLinks: [], cnicNumberHash: 'h', whatsappNumber: '+923001234567',
  communityLinks: [{ url: 'https://chat.whatsapp.com/old' }], referenceUrl: null, basicState: 'pending', enhancedState: 'pending', ...o,
})
const status = async (item: string) => (await reviewState('s1')).items.find((i) => i.item === item)!.status

beforeEach(() => {
  st.sub = sub(); st.events = []; st.user = { kycLevel: 'none' }; st.userUpdates = []; st.audits = []; st.clock = 0; st.conflictHash = false; st.incr = 0
  for (const f of [st.notify, st.email, st.adminNotif, st.maker, st.merge]) f.mockReset()
  st.email.mockResolvedValue(undefined)
})

describe('Basic approved while Enhanced needs a correction', () => {
  it('approves Basic, asks for only the community link, and keeps everything else', async () => {
    await recordItemDecision('s1', 'community', 'resubmit', 'This group link is dead', ADMIN)
    await requestChanges('s1', ADMIN)
    expect(st.sub).toMatchObject({ basicState: 'pending', enhancedState: 'changes_requested', status: 'pending' })
    expect(st.notify).toHaveBeenCalledWith('u1', 'kyc', 'KYC: changes needed', expect.stringContaining('Community link: This group link is dead'), expect.anything())

    const r = await approvePart('s1', 'basic', ADMIN)
    expect(r.status).toBe('pending') // Enhanced is still open
    expect(st.sub).toMatchObject({ basicState: 'approved', enhancedState: 'changes_requested', status: 'pending' })
    expect(st.user).toMatchObject({ kycStatus: 'approved', kycLevel: 'basic', dailyBuyLimit: 50000 })
    expect(st.maker).not.toHaveBeenCalled() // no maker rights from Basic
    expect(await status('selfie')).toBe('approved')
    expect(await status('community')).toBe('resubmit')
  })

  it('Enhanced and maker rights stay locked until its own checks pass', async () => {
    await approvePart('s1', 'basic', ADMIN)
    await recordItemDecision('s1', 'whatsapp', 'resubmit', 'Not reachable', ADMIN)
    await expect(approvePart('s1', 'enhanced', ADMIN)).rejects.toThrow(/WhatsApp number/)
    expect(st.user.kycLevel).toBe('basic')
    expect(st.maker).not.toHaveBeenCalled()
  })

  it('Enhanced cannot be approved before Basic', async () => {
    await expect(approvePart('s1', 'enhanced', ADMIN)).rejects.toThrow(/Approve Basic first/)
  })

  it('the applicant sends back only that item; the part returns to review and approved items are untouched', async () => {
    await recordItemDecision('s1', 'community', 'resubmit', 'dead link', ADMIN)
    await requestChanges('s1', ADMIN)
    await approvePart('s1', 'basic', ADMIN)
    const before = st.events.length

    await expect(resubmitItems('u1', 's1', { selfieUrl: 'https://res.cloudinary.com/new' })).rejects.toThrow(/was not sent back/)
    await resubmitItems('u1', 's1', { communityLinks: [{ url: 'https://chat.whatsapp.com/AbCdEf123456' }] })

    expect(st.sub.communityLinks).toEqual([{ url: 'https://chat.whatsapp.com/AbCdEf123456' }])
    expect(st.sub.selfieUrl).toBe('https://res.cloudinary.com/s1') // untouched
    expect(st.sub).toMatchObject({ basicState: 'approved', enhancedState: 'pending' })
    const added = st.events.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ item: 'community', status: 'resubmitted', actorId: 'u1' })
    expect(added[0]!.previousValue).toContain('chat.whatsapp.com/old') // the replaced value is kept
    expect(st.adminNotif).toHaveBeenCalled()
  })

  it('a part stays with the applicant until every flagged item in it is replaced', async () => {
    await recordItemDecision('s1', 'community', 'resubmit', 'dead', ADMIN)
    await recordItemDecision('s1', 'whatsapp', 'resubmit', 'wrong', ADMIN)
    await requestChanges('s1', ADMIN)
    await resubmitItems('u1', 's1', { whatsappNumber: '+923009998877' })
    expect(st.sub.enhancedState).toBe('changes_requested')
    await resubmitItems('u1', 's1', { communityLinks: [{ url: 'https://t.me/mygroup123' }] })
    expect(st.sub.enhancedState).toBe('pending')
  })
})

describe('guards', () => {
  it('a flagged identity item blocks Basic until it is replaced', async () => {
    await recordItemDecision('s1', 'selfie', 'rejected', 'Not you', ADMIN)
    await expect(approvePart('s1', 'basic', ADMIN)).rejects.toThrow(/Selfie/)
    expect(st.sub.basicState).toBe('pending')
  })
  it('a reason is required to send an item back, and a decided part cannot be edited', async () => {
    await expect(recordItemDecision('s1', 'selfie', 'resubmit', '  ', ADMIN)).rejects.toThrow(/Say what is wrong/)
    await approvePart('s1', 'basic', ADMIN)
    await expect(recordItemDecision('s1', 'selfie', 'resubmit', 'x', ADMIN)).rejects.toThrow(/already decided/)
  })
  it('an item that is not part of the submission is refused', async () => {
    st.sub = sub({ tier: 'basic', enhancedState: 'not_requested' })
    await expect(recordItemDecision('s1', 'whatsapp', 'approved', undefined, ADMIN)).rejects.toThrow(/not part of this submission/)
  })
  it('an ID already verified on another account cannot be approved', async () => {
    st.conflictHash = true
    await expect(approvePart('s1', 'basic', ADMIN)).rejects.toMatchObject({ code: 'CNIC_DUPLICATE' })
    expect(st.user.kycStatus).toBeUndefined()
  })
  it('two reviewers cannot approve the same part twice', async () => {
    await approvePart('s1', 'basic', ADMIN)
    await expect(approvePart('s1', 'basic', ADMIN)).rejects.toThrow()
    expect(st.userUpdates).toHaveLength(1)
  })
  it('an applicant cannot touch another person\'s submission or a closed one', async () => {
    await recordItemDecision('s1', 'selfie', 'resubmit', 'blurry', ADMIN)
    await expect(resubmitItems('intruder', 's1', { selfieUrl: 'https://res.cloudinary.com/x' })).rejects.toThrow()
    st.sub.status = 'approved'
    await expect(resubmitItems('u1', 's1', { selfieUrl: 'https://res.cloudinary.com/x' })).rejects.toThrow(/closed/)
  })
  it('replacement values are validated like a fresh submission', async () => {
    await recordItemDecision('s1', 'selfie', 'resubmit', 'blurry', ADMIN)
    await recordItemDecision('s1', 'whatsapp', 'resubmit', 'wrong', ADMIN)
    await expect(resubmitItems('u1', 's1', { selfieUrl: 'https://evil.example/x.png' })).rejects.toThrow()
    await expect(resubmitItems('u1', 's1', { whatsappNumber: 'abc' })).rejects.toThrow(/WhatsApp/)
  })
})

describe('upgrades and rejections do not damage what was approved', () => {
  it('Basic approval does not lower a user who is already Enhanced', async () => {
    st.user = { kycLevel: 'enhanced' }
    await approvePart('s1', 'basic', ADMIN)
    expect(st.userUpdates[0]).not.toHaveProperty('kycLevel')
    expect(st.userUpdates[0]).not.toHaveProperty('dailyBuyLimit')
  })
  it('approving both parts grants Enhanced and the maker review', async () => {
    await approvePart('s1', 'basic', ADMIN, { silent: true })
    await approvePart('s1', 'enhanced', ADMIN)
    expect(st.user).toMatchObject({ kycLevel: 'enhanced', dailyBuyLimit: 500000 })
    expect(st.maker).toHaveBeenCalledWith('admin1', 'u1')
    expect(st.sub.status).toBe('approved')
  })
  it('rejecting Enhanced leaves an approved Basic and the user verified', async () => {
    await approvePart('s1', 'basic', ADMIN)
    await rejectPart('s1', 'all', 'Group is not real', ADMIN)
    expect(st.sub).toMatchObject({ basicState: 'approved', enhancedState: 'rejected', status: 'approved' })
    expect(st.user.kycStatus).toBe('approved')
  })
  it('rejecting an Enhanced request restores the verified status that submitting it had set to pending', async () => {
    st.sub = sub({ basicState: 'approved' }) // identity approved earlier, only Enhanced is new
    st.user = { kycLevel: 'basic', kycStatus: 'pending' }
    await rejectPart('s1', 'enhanced', 'Group is not real', ADMIN)
    expect(st.user.kycStatus).toBe('approved')
    expect(st.sub.status).toBe('approved')
  })
  it('rejecting identity rejects everything and flips the user, like before', async () => {
    await rejectPart('s1', 'all', 'Photos do not match', ADMIN)
    expect(st.sub).toMatchObject({ basicState: 'rejected', enhancedState: 'rejected', status: 'rejected' })
    expect(st.user.kycStatus).toBe('rejected')
  })
  it('a reason is required to reject', async () => {
    await expect(rejectPart('s1', 'all', ' ', ADMIN)).rejects.toThrow(/reason/)
  })
})

describe('decisions are recorded for the audit trail', () => {
  it('every item decision and approval is written with the reviewer', async () => {
    await recordItemDecision('s1', 'community', 'resubmit', 'dead', ADMIN)
    await approvePart('s1', 'basic', ADMIN)
    expect(st.audits.map((a) => a.action)).toEqual(['KYC_ITEM_REVIEWED', 'KYC_BASIC_APPROVED'])
    expect(st.audits.every((a) => a.actorId === 'admin1')).toBe(true)
  })
})
