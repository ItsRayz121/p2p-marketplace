import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn() },
    gasFeeOrder: { findUnique: vi.fn() },
    gasShareReward: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    gasTokenConfig: { findUnique: vi.fn() },
    platformConfig: { findUnique: vi.fn() },
  },
  verify: vi.fn(),
  notify: vi.fn(),
  numbers: {} as Record<string, number>,
  flags: { referral: true },
}))
vi.mock('../../prisma', () => ({ db: m.db }))
vi.mock('../../env', () => ({ env: { FRONTEND_URL: 'https://rupchain.test' } }))
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('../../notify', () => ({ notify: m.notify }))
vi.mock('../../../services/adminNotification.service', () => ({ createAdminNotif: vi.fn() }))
vi.mock('../../../services/platformFlags.service', () => ({
  getBoolConfig: vi.fn(async (k: string) => k === 'share_reward_enabled'),
  getNumberConfig: vi.fn(async (k: string, d: number) => m.numbers[k] ?? d),
  isFlagEnabled: vi.fn(async () => m.flags.referral),
  FLAGS: { GAS_REFERRAL: 'gas_referral' },
}))
vi.mock('../gas.referral', () => ({ getOrCreateOwnCode: vi.fn(async () => 'CODE') }))
vi.mock('../../social/xVerification', () => ({ verifyShareReward: m.verify, X_VERIFY_AUTO_APPROVE_KEY: 'auto' }))

import { getShareInfo, submitSharePost } from '../gas.share'

const NOW = Date.now()
const order = {
  id: 'o1', orderRef: 'GF-1', userId: 'u1', status: 'delivered', isFreeGrant: false, chain: 'BSC',
  gasAmountNative: '0.0001', paymentCoin: 'USDT', gasTokenConfigId: 'tc1',
  deliveredAt: new Date(NOW - 10 * 60_000), updatedAt: new Date(NOW - 10 * 60_000),
}
const reward = (over: Record<string, unknown> = {}) => ({
  id: 'r1', status: 'submitted', discountPct: null, rejectionReason: null, postUrl: 'https://x.com/a/status/123456', verifyIssues: null, ...over,
})
const POST = 'https://x.com/a/status/9876543210'

beforeEach(() => {
  vi.clearAllMocks()
  m.numbers = {}
  m.flags.referral = true
  m.db.user.findUnique.mockResolvedValue({ email: 'fazalelahi057@gmail.com', username: 'fazal' })
  m.db.gasFeeOrder.findUnique.mockResolvedValue(order)
  m.db.gasTokenConfig.findUnique.mockResolvedValue({ symbol: 'BNB', chain: { name: 'BNB Smart Chain', slug: 'BSC', logoUrl: null } })
  m.db.gasShareReward.findUnique.mockResolvedValue(null)
  m.db.platformConfig.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key === 'share_reward_x_handle' ? { value: '@RupChainHQ' } : null))
  m.db.gasShareReward.create.mockResolvedValue({ id: 'r1' })
  m.db.gasShareReward.update.mockResolvedValue({})
  m.verify.mockResolvedValue({ ran: false })
})

describe('getShareInfo', () => {
  it('returns the real order facts, the template for the chosen variant and a caption that matches the link', async () => {
    const i = await getShareInfo('u1', 'GF-1', 4)
    expect(i.eligible).toBe(true)
    expect(i.card).toMatchObject({ amount: '0.0001', symbol: 'BNB', chainKey: 'BSC', paidWith: 'USDT', template: 'experience' })
    expect(i.link).toBe('https://rupchain.test/s/GF-1?v=1')
    expect(i.text).toContain(i.link!)
    expect(i.text).toContain('@RupChainHQ')
    expect(i.hashtags).toEqual(['#RupChain', '#BNBGasFees', '#ad'])
  })
  it('says PKR when the customer paid in PKR', async () => {
    m.db.gasFeeOrder.findUnique.mockResolvedValue({ ...order, paymentCoin: 'PKR' })
    expect((await getShareInfo('u1', 'GF-1', 0)).card?.paidWith).toBe('PKR')
  })
  it('is not eligible for another user, an undelivered order or after the window', async () => {
    await expect(getShareInfo('someone-else', 'GF-1', 0)).rejects.toThrow()
    m.db.gasFeeOrder.findUnique.mockResolvedValue({ ...order, status: 'sending' })
    expect((await getShareInfo('u1', 'GF-1', 0)).eligible).toBe(false)
    m.db.gasFeeOrder.findUnique.mockResolvedValue({ ...order, deliveredAt: new Date(NOW - 3 * 3_600_000) })
    expect(await getShareInfo('u1', 'GF-1', 0)).toMatchObject({ eligible: false, reason: 'This offer has expired.' })
  })
  it('keeps a post that needs changes open for fixing until the window ends', async () => {
    m.db.gasShareReward.findUnique.mockResolvedValue(reward({ status: 'changes_required', verifyIssues: ['Mention @RupChainHQ in the post.'] }))
    const i = await getShareInfo('u1', 'GF-1', 0)
    expect(i.eligible).toBe(true)
    expect(i.reward).toMatchObject({ status: 'changes_required', issues: ['Mention @RupChainHQ in the post.'] })
    m.db.gasFeeOrder.findUnique.mockResolvedValue({ ...order, deliveredAt: new Date(NOW - 3 * 3_600_000) })
    expect((await getShareInfo('u1', 'GF-1', 0)).eligible).toBe(false)
  })
  it('keeps showing an approved reward after the window', async () => {
    m.db.gasShareReward.findUnique.mockResolvedValue(reward({ status: 'approved', discountPct: 28 }))
    m.db.gasFeeOrder.findUnique.mockResolvedValue({ ...order, deliveredAt: new Date(NOW - 3 * 3_600_000) })
    const i = await getShareInfo('u1', 'GF-1', 0)
    expect(i.eligible).toBe(true)
    expect(i.reward?.discountPct).toBe(28)
  })
  it('falls back to /gas when referrals are off', async () => {
    m.flags.referral = false
    expect((await getShareInfo('u1', 'GF-1', 0)).link).toBe('https://rupchain.test/gas')
  })
})

describe('submitSharePost', () => {
  it('creates the reward and starts the automated check without waiting for it', async () => {
    expect(await submitSharePost('u1', 'GF-1', POST)).toEqual({ status: 'submitted' })
    expect(m.db.gasShareReward.create).toHaveBeenCalledOnce()
    expect(m.verify).toHaveBeenCalledWith('r1')
  })
  it('rejects links that are not X posts', async () => {
    await expect(submitSharePost('u1', 'GF-1', 'https://example.com/a/status/123456')).rejects.toThrow()
    expect(m.db.gasShareReward.create).not.toHaveBeenCalled()
  })
  it('refuses a second submission while the first is under review', async () => {
    m.db.gasShareReward.findUnique.mockResolvedValue(reward())
    await expect(submitSharePost('u1', 'GF-1', POST)).rejects.toMatchObject({ code: 'SHARE_ALREADY_SUBMITTED' })
  })
  it('lets the user fix a post that needed changes on the same reward row', async () => {
    m.db.gasShareReward.findUnique.mockResolvedValue(reward({ status: 'changes_required' }))
    await submitSharePost('u1', 'GF-1', POST)
    expect(m.db.gasShareReward.create).not.toHaveBeenCalled()
    expect(m.db.gasShareReward.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'r1' }, data: { status: 'submitted', postKey: '9876543210', verifyStatus: null } })
    expect(m.verify).toHaveBeenCalledWith('r1')
  })
  it('reports a post that someone already used', async () => {
    m.db.gasShareReward.create.mockRejectedValue(new Error('Unique constraint'))
    await expect(submitSharePost('u1', 'GF-1', POST)).rejects.toMatchObject({ code: 'POST_ALREADY_USED' })
  })
  it('tells the user when the check found something to change', async () => {
    m.verify.mockResolvedValue({ ran: true, outcome: 'failed' })
    m.db.gasShareReward.findUnique.mockImplementation(async ({ where }: { where: { id?: string; sourceOrderId?: string } }) =>
      where.id ? { status: 'changes_required', verifyIssues: ['Keep the #ad disclosure in the post.'], verifyStatus: 'failed' } : null)
    await submitSharePost('u1', 'GF-1', POST)
    await vi.waitFor(() => expect(m.notify).toHaveBeenCalled())
    expect(m.notify.mock.calls[0]![2]).toMatch(/needs a change/)
    expect(m.notify.mock.calls[0]![3]).toContain('#ad')
  })
})
