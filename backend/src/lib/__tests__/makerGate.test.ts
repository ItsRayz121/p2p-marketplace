import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  adCount: vi.fn(),
  listingCount: vi.fn(),
  isFlagEnabled: vi.fn(),
  getNumberConfig: vi.fn(),
}))

vi.mock('../prisma', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique },
    ad: { count: mocks.adCount },
    ctmListing: { count: mocks.listingCount },
  },
}))
vi.mock('../../services/platformFlags.service', () => ({
  FLAGS: { MAKER_GATE: 'maker_gate_enabled' },
  isFlagEnabled: mocks.isFlagEnabled,
  getNumberConfig: mocks.getNumberConfig,
}))

import { getMakerStatus, assertMakerEligible, decideInitialStatus, normalizeWhatsapp } from '../makerGate'

const fullUser = {
  kycStatus: 'approved', kycLevel: 'enhanced', username: 'ali', telegramId: BigInt(1), whatsappNumber: '+923001234567',
  makerStatus: 'approved', makerReviewNote: null, isTrusted: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getNumberConfig.mockImplementation(async (key: string, fallback: number) => (key === 'maker_review_first_n' ? 3 : fallback))
})

describe('normalizeWhatsapp', () => {
  it('normalises common formats and rejects junk', () => {
    expect(normalizeWhatsapp('+92 300 1234567')).toBe('+923001234567')
    expect(normalizeWhatsapp('0092-300-1234567'.replace('00', '+'))).toBe('+923001234567')
    expect(normalizeWhatsapp('923001234567')).toBe('+923001234567')
    expect(normalizeWhatsapp('12345')).toBeNull()
    expect(normalizeWhatsapp('1'.repeat(20))).toBeNull()
    expect(normalizeWhatsapp('not a number')).toBeNull()
  })
})

describe('assertMakerEligible', () => {
  it('is a no-op while the gate is OFF, whatever the user looks like', async () => {
    mocks.isFlagEnabled.mockResolvedValue(false)
    await expect(assertMakerEligible('u1')).resolves.toBeUndefined()
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
  })

  it('blocks an unapproved user and names what is missing', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, kycLevel: 'basic', whatsappNumber: null, makerStatus: 'none' })
    await expect(assertMakerEligible('u1')).rejects.toMatchObject({ code: 'MAKER_NOT_APPROVED', statusCode: 403 })
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, kycLevel: 'basic', whatsappNumber: null, makerStatus: 'none' })
    await expect(assertMakerEligible('u1')).rejects.toThrow(/Level 2 KYC.*WhatsApp/)
  })

  it('lets a fully approved maker and a trusted account through', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue(fullUser)
    await expect(assertMakerEligible('u1')).resolves.toBeUndefined()
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, kycLevel: 'none', makerStatus: 'none', isTrusted: true })
    await expect(assertMakerEligible('u2')).resolves.toBeUndefined()
  })
})

describe('getMakerStatus', () => {
  it('canApply only when every prerequisite except approval is met and not already pending/approved', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, makerStatus: 'none' })
    expect((await getMakerStatus('u')).canApply).toBe(true)
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, makerStatus: 'pending' })
    expect((await getMakerStatus('u')).canApply).toBe(false)
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, makerStatus: 'rejected' })
    expect((await getMakerStatus('u')).canApply).toBe(true)
    mocks.userFindUnique.mockResolvedValue({ ...fullUser, makerStatus: 'none', telegramId: null })
    expect((await getMakerStatus('u')).canApply).toBe(false)
  })
})

describe('decideInitialStatus', () => {
  it('is always active when the gate is OFF or the user is trusted', async () => {
    mocks.isFlagEnabled.mockResolvedValue(false)
    expect(await decideInitialStatus('u', 10)).toBe('active')
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue({ isTrusted: true })
    expect(await decideInitialStatus('u', 10)).toBe('active')
  })

  it('reviews a maker\'s first N ads, then goes live', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue({ isTrusted: false })
    mocks.adCount.mockResolvedValue(1); mocks.listingCount.mockResolvedValue(1) // 2 < 3
    expect(await decideInitialStatus('u', 50)).toBe('pending_review')
    mocks.adCount.mockResolvedValue(2); mocks.listingCount.mockResolvedValue(1) // 3 !< 3
    expect(await decideInitialStatus('u', 50)).toBe('active')
  })

  it('also reviews an ad above the optional size threshold', async () => {
    mocks.isFlagEnabled.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue({ isTrusted: false })
    mocks.getNumberConfig.mockImplementation(async (key: string, fallback: number) => (key === 'maker_review_above_usdt' ? 500 : key === 'maker_review_first_n' ? 3 : fallback))
    mocks.adCount.mockResolvedValue(10); mocks.listingCount.mockResolvedValue(0)
    expect(await decideInitialStatus('u', 800)).toBe('pending_review')
    expect(await decideInitialStatus('u', 100)).toBe('active')
    expect(await decideInitialStatus('u', null)).toBe('active')
  })
})
