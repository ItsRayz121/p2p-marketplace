import { describe, it, expect, vi, beforeEach } from 'vitest'

// requestWithdrawal talks to Redis, Prisma and a few services. Everything is mocked so the
// test exercises only the new guard rails: per-user idempotency scoping, the in-flight
// lock, address validation, and fee/total arithmetic.

const store = new Map<string, string>()
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...rest: unknown[]) => {
    if (rest.includes('NX') && store.has(k)) return null
    store.set(k, v)
    return 'OK'
  }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1 }),
}

const txWallet = { id: 'w1', balance: '1000', lockedBalance: '0' }
const walletUpdate = vi.fn(async () => ({}))
const withdrawalCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `wd_${withdrawalCreate.mock.calls.length}`, orderRef: 'WDR-X', ...data }))
const tx = {
  $queryRaw: vi.fn(async () => [txWallet]),
  wallet: { update: walletUpdate },
  withdrawal: { create: withdrawalCreate },
  transaction: { create: vi.fn(async () => ({})) },
}
const dbMock = {
  $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
    await new Promise((r) => setTimeout(r, 15)) // widen the race window
    return fn(tx)
  }),
  trustedWithdrawalAddress: { findFirst: vi.fn(async () => null) },
  platformConfig: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
    if (where.key.startsWith('withdrawal_gas_fee_')) return { value: '0.1' }
    if (where.key.startsWith('withdrawal_platform_fee_')) return { value: '0.2' }
    return null
  }) },
}

vi.mock('../../lib/prisma', () => ({ db: dbMock }))
vi.mock('../../lib/redis', () => ({ redis: redisMock }))
vi.mock('../../lib/env', () => ({ env: { FRONTEND_URL: 'https://example.test' } }))
vi.mock('../../lib/audit', () => ({ recordAuditLog: vi.fn(async () => {}) }))
vi.mock('../../lib/hash', () => ({ generateOrderRef: () => 'WDR-TEST' }))
vi.mock('../../lib/withdrawal.sender', () => ({ sendWithdrawalOnChain: vi.fn(async () => {}) }))
vi.mock('../chainRegistry.service', () => ({ getChainByNetworkLabel: vi.fn(), isEvmNetwork: vi.fn() }))
vi.mock('../depositAddress.service', () => ({ getOrCreateEvmDepositAddress: vi.fn(), getOrCreateAptosDepositAddress: vi.fn() }))
vi.mock('../email.service', () => ({ sendWithdrawalEmail: vi.fn(async () => {}), sendWithdrawalConfirmationEmail: vi.fn(async () => {}) }))
vi.mock('../withdrawal-risk.service', () => ({
  assessWithdrawalRisk: vi.fn(),
  getWithdrawalTierConfig: vi.fn(async () => ({
    tier1MaxUsd: 100,
    coinPricesUsd: { USDT: 1 },
    emailConfirmationEnabled: false,
    addressActivationHours: 24,
  })),
}))
vi.mock('../withdrawal-security.service', () => ({
  assertWithdrawalNotLocked: vi.fn(async () => {}),
  storeConfirmationTokens: vi.fn(),
  consumeConfirmToken: vi.fn(),
  consumeCancelToken: vi.fn(),
  incrementResendCount: vi.fn(),
  MAX_RESENDS: 3,
  cancelExpiredConfirmations: vi.fn(),
}))

const { requestWithdrawal } = await import('../wallet.service')

const GOOD_ADDR = 'T' + 'a'.repeat(33)
const base = { coin: 'USDT', network: 'TRC20', amount: 10, toAddress: GOOD_ADDR }

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
})

describe('requestWithdrawal idempotency and validation', () => {
  it('two concurrent requests with the same key debit the wallet once', async () => {
    const results = await Promise.allSettled([
      requestWithdrawal('u1', { ...base, idempotencyKey: 'key-1' }),
      requestWithdrawal('u1', { ...base, idempotencyKey: 'key-1' }),
    ])
    expect(withdrawalCreate).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { statusCode?: number }).statusCode).toBe(409)
  })

  it('a retry after completion replays the cached result without a second debit', async () => {
    const first = await requestWithdrawal('u1', { ...base, idempotencyKey: 'key-2' })
    const second = await requestWithdrawal('u1', { ...base, idempotencyKey: 'key-2' })
    expect(withdrawalCreate).toHaveBeenCalledTimes(1)
    expect((second as { id: string }).id).toBe((first as { id: string }).id)
  })

  it("another user's identical key never returns the first user's withdrawal", async () => {
    const a = await requestWithdrawal('u1', { ...base, idempotencyKey: 'shared-key' })
    const b = await requestWithdrawal('u2', { ...base, idempotencyKey: 'shared-key' })
    expect(withdrawalCreate).toHaveBeenCalledTimes(2)
    expect((b as { id: string }).id).not.toBe((a as { id: string }).id)
    expect((b as { userId: string }).userId).toBe('u2')
  })

  it('rejects a malformed on-chain address before touching the wallet', async () => {
    await expect(
      requestWithdrawal('u1', { ...base, toAddress: 'not-an-address', idempotencyKey: 'key-3' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(dbMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an unsafe idempotency key', async () => {
    await expect(requestWithdrawal('u1', { ...base, idempotencyKey: 'bad key\n' })).rejects.toMatchObject({ statusCode: 400 })
    expect(dbMock.$transaction).not.toHaveBeenCalled()
  })

  it('debits amount + fee exactly (0.1 + 0.2 fee has no float residue)', async () => {
    await requestWithdrawal('u1', { ...base, amount: 0.1, idempotencyKey: 'key-4' })
    const arg = (walletUpdate.mock.calls[0] as unknown[])[0] as { data: { balance: { decrement: { toString(): string } } } }
    expect(arg.data.balance.decrement.toString()).toBe('0.4')
  })

  it('releases the lock after a failure so the same key can be retried', async () => {
    txWallet.balance = '1'
    await expect(requestWithdrawal('u1', { ...base, idempotencyKey: 'key-5' })).rejects.toMatchObject({ statusCode: 400 })
    txWallet.balance = '1000'
    await expect(requestWithdrawal('u1', { ...base, idempotencyKey: 'key-5' })).resolves.toBeTruthy()
  })
})
