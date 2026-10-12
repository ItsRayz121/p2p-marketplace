import { describe, it, expect, vi, beforeEach } from 'vitest'

// A tiny in-memory stand-in for the collateral tables. Each call yields to the event loop
// (like a real DB round trip) so two concurrent unlocks genuinely interleave; updateMany
// applies its filter and write in one synchronous step, as Postgres does for a single UPDATE.
const lockRow = { id: 'L1', userId: 'u1', coin: 'USDT', amount: '50', status: 'locked' as string }
const walletDecrements: string[] = []
const tick = () => new Promise((r) => setTimeout(r, 5))

const tx = {
  collateralLock: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string; status: string } }) => {
      await tick()
      return lockRow.id === where.id && lockRow.userId === where.userId && lockRow.status === where.status ? { ...lockRow } : null
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; userId: string; status: string }; data: { status: string } }) => {
      await tick()
      if (lockRow.id === where.id && lockRow.userId === where.userId && lockRow.status === where.status) {
        lockRow.status = data.status
        return { count: 1 }
      }
      return { count: 0 }
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...lockRow })),
    update: vi.fn(async ({ data }: { data: { status: string } }) => {
      await tick()
      lockRow.status = data.status
      return { ...lockRow }
    }),
  },
  wallet: {
    updateMany: vi.fn(async ({ data }: { data: { lockedBalance: { decrement: unknown } } }) => {
      walletDecrements.push(String(data.lockedBalance.decrement))
      return { count: 1 }
    }),
  },
}
const dbMock = {
  trade: { count: vi.fn(async () => 0) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
}

vi.mock('../../lib/prisma', () => ({ db: dbMock }))
vi.mock('../../lib/redis', () => ({ redis: {} }))
vi.mock('../../lib/env', () => ({ env: {} }))
vi.mock('../../lib/audit', () => ({ recordAuditLog: vi.fn() }))
vi.mock('../../lib/withdrawal.sender', () => ({ sendWithdrawalOnChain: vi.fn() }))
vi.mock('../chainRegistry.service', () => ({ getChainByNetworkLabel: vi.fn(), isEvmNetwork: vi.fn() }))
vi.mock('../depositAddress.service', () => ({ getOrCreateEvmDepositAddress: vi.fn(), getOrCreateAptosDepositAddress: vi.fn() }))
vi.mock('../email.service', () => ({ sendWithdrawalEmail: vi.fn(), sendWithdrawalConfirmationEmail: vi.fn() }))
vi.mock('../withdrawal-risk.service', () => ({ assessWithdrawalRisk: vi.fn(), getWithdrawalTierConfig: vi.fn() }))
vi.mock('../withdrawal-security.service', () => ({
  assertWithdrawalNotLocked: vi.fn(),
  storeConfirmationTokens: vi.fn(),
  consumeConfirmToken: vi.fn(),
  consumeCancelToken: vi.fn(),
  incrementResendCount: vi.fn(),
  MAX_RESENDS: 3,
  cancelExpiredConfirmations: vi.fn(),
}))

const { unlockCollateral } = await import('../wallet.service')

beforeEach(() => {
  lockRow.status = 'locked'
  walletDecrements.length = 0
  vi.clearAllMocks()
})

describe('unlockCollateral', () => {
  it('two concurrent unlocks of the same lock release the amount exactly once', async () => {
    const results = await Promise.allSettled([unlockCollateral('u1', 'L1'), unlockCollateral('u1', 'L1')])
    expect(walletDecrements).toHaveLength(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { statusCode?: number }).statusCode).toBe(404)
  })

  it("another user cannot unlock someone else's lock", async () => {
    await expect(unlockCollateral('intruder', 'L1')).rejects.toMatchObject({ statusCode: 404 })
    expect(walletDecrements).toHaveLength(0)
    expect(lockRow.status).toBe('locked')
  })

  it('a normal unlock marks the lock unlocked and releases its amount', async () => {
    const lock = await unlockCollateral('u1', 'L1')
    expect(lock.status).toBe('unlocked')
    expect(walletDecrements).toEqual(['50'])
  })
})
