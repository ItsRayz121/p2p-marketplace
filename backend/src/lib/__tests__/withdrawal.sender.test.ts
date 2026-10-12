import { describe, it, expect, vi, beforeEach } from 'vitest'

// The EVM auto-sender used to broadcast first and only claim the row afterwards. These tests pin
// the new behaviour: re-read + Redis claim inside the hot-wallet lock, before any broadcast.

const claims = new Map<string, string>()
const redisMock = {
  set: vi.fn(async (k: string, v: string, ...rest: unknown[]) => {
    if (rest.includes('NX') && claims.has(k)) return null
    claims.set(k, v)
    return 'OK'
  }),
  del: vi.fn(async (k: string) => { claims.delete(k); return 1 }),
  exists: vi.fn(async (k: string) => (claims.has(k) ? 1 : 0)),
}

const row = { status: 'auto_approved', txHash: null as string | null }
const dbMock = {
  withdrawal: {
    findUnique: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
}

const writeContract = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 15)) // a real broadcast takes time
  return ('0x' + 'ab'.repeat(32)) as `0x${string}`
})
const finalize = vi.fn(async () => true)
const notif = vi.fn(async () => {})

vi.mock('viem', () => ({
  createWalletClient: () => ({ writeContract }),
  http: () => ({}),
  parseUnits: () => 1n,
}))
vi.mock('viem/accounts', () => ({ privateKeyToAccount: () => ({ address: '0xhot' }) }))
vi.mock('viem/chains', () => ({ arbitrum: {}, base: {}, bsc: {}, mainnet: {}, optimism: {}, polygon: {} }))
vi.mock('../env', () => ({ env: { GAS_SEED_CIPHERTEXT: 'x', BSC_RPC_URL: 'http://rpc', ETH_RPC_URL: 'http://rpc' } }))
vi.mock('../prisma', () => ({ db: dbMock }))
vi.mock('../redis', () => ({ redis: redisMock }))
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../gas/gasWalletService', () => ({
  decryptGasSeed: () => Buffer.alloc(32),
  deriveEvmPrivateKeyHex: () => '0x' + '11'.repeat(32),
  getEvmHotWalletAddress: () => null, // skips the gas pre-flight
  HOT_WALLET_INDEX: 0,
}))
vi.mock('../../services/chainRegistry.service', () => ({
  getChainByNetworkLabel: async () => ({ id: 'bsc', tokens: [{ symbol: 'USDT', address: '0xtoken', decimals: 18 }] }),
  getRpcUrl: () => 'http://rpc',
}))
vi.mock('../../services/adminNotification.service', () => ({ createAdminNotif: notif }))
vi.mock('../evmRpc', () => ({ getEvmGasPrice: vi.fn(), getTransactionCount: async () => 7 }))
vi.mock('../hotWalletLock', () => ({ withHotWalletLock: async (_c: string, fn: () => unknown) => fn() }))
vi.mock('../gas/gas.balance', () => ({ getHotWalletBalance: vi.fn() }))
vi.mock('../withdrawal.aptos.sender', () => ({ sendAptosWithdrawalOnChain: vi.fn() }))
vi.mock('../withdrawal.finalize', () => ({ finalizeWithdrawalSent: finalize }))

const { sendWithdrawalOnChain, evmWithdrawalClaimHeld } = await import('../withdrawal.sender')

const wd = { id: 'wd1', userId: 'u1', coin: 'USDT', network: 'BEP20', amount: '10', fee: '0.3', toAddress: '0x' + 'cd'.repeat(20) }

beforeEach(() => {
  claims.clear()
  row.status = 'auto_approved'
  row.txHash = null
  vi.clearAllMocks()
})

describe('sendWithdrawalOnChain (EVM)', () => {
  it('two concurrent sends of the same withdrawal broadcast once', async () => {
    await Promise.all([sendWithdrawalOnChain(wd), sendWithdrawalOnChain(wd)])
    expect(writeContract).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('does not broadcast a withdrawal that was rejected before the send ran', async () => {
    row.status = 'rejected'
    await sendWithdrawalOnChain(wd)
    expect(writeContract).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
  })

  it('does not broadcast when a txHash is already recorded', async () => {
    row.txHash = '0x' + 'ee'.repeat(32)
    await sendWithdrawalOnChain(wd)
    expect(writeContract).not.toHaveBeenCalled()
  })

  it('releases the claim after a successful finalize', async () => {
    await sendWithdrawalOnChain(wd)
    expect(await evmWithdrawalClaimHeld('wd1')).toBe(false)
  })

  it('keeps the claim when finalize throws and the status cannot be salvaged (blocks a resend)', async () => {
    finalize.mockRejectedValueOnce(new Error('db down'))
    dbMock.withdrawal.updateMany.mockRejectedValueOnce(new Error('db still down'))
    await sendWithdrawalOnChain(wd)
    expect(await evmWithdrawalClaimHeld('wd1')).toBe(true)
    expect(notif).toHaveBeenCalled()
    // the recovery pass re-driving it must not broadcast again
    await sendWithdrawalOnChain(wd)
    expect(writeContract).toHaveBeenCalledTimes(1)
  })

  it('releases the claim when the broadcast itself fails, so an admin retry is possible', async () => {
    writeContract.mockRejectedValueOnce(new Error('rpc exploded'))
    await sendWithdrawalOnChain(wd)
    expect(await evmWithdrawalClaimHeld('wd1')).toBe(false)
    expect(notif).toHaveBeenCalled()
  })

  it('alerts an admin when the row moved on after the transfer was broadcast', async () => {
    finalize.mockResolvedValueOnce(false)
    await sendWithdrawalOnChain(wd)
    expect(notif).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('already changed') }))
  })
})
