/**
 * Unit tests for normalizeMoralisEvent — ensures ERC20/BEP20 token transfers are
 * classified as TOKEN events (with the source-provided decimals captured), and
 * native transfers as native. This is the parsing layer behind the "USDT shown
 * as BNB" fix: a token transfer must never be treated as native.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../chainRegistry.service', () => ({
  getAllChains: vi.fn(async () => [
    { id: 'bsc', chainId: 56, family: 'EVM', nativeSymbol: 'BNB', minConfirmations: 3, networkLabel: 'BEP20', tokens: [] },
  ]),
  getRpcUrl: vi.fn(() => undefined),
}))

import { normalizeMoralisEvent } from '../depositWatcher.service'

describe('normalizeMoralisEvent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captures token decimals from an ERC20 transfer and marks it as a token (not native)', async () => {
    const events = await normalizeMoralisEvent({
      chainId: '0x38', // 56 = BSC
      confirmed: true,
      erc20Transfers: [{
        transactionHash: '0xtoken',
        from: '0xsender',
        to: '0xhotwallet',
        value: '160000000000000000', // 0.16 with 18 decimals
        contract: '0x55d398326f99059fF775485246999027B3197955',
        tokenSymbol: 'USDT',
        tokenDecimals: 18,
      }],
    })
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.asset).not.toBe('native')                 // must be the contract address
    expect(e.asset.toLowerCase()).toContain('0x55d398')
    expect(e.symbol).toBe('USDT')
    expect(e.decimals).toBe(18)                         // decimals captured, not guessed
    expect(e.amount).toBe('160000000000000000')         // raw units preserved
  })

  it('marks a native transfer as native with no token decimals', async () => {
    const events = await normalizeMoralisEvent({
      chainId: '0x38',
      confirmed: true,
      txs: [{ hash: '0xnative', fromAddress: '0xa', toAddress: '0xhotwallet', value: '1000000000000000000' }],
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.asset).toBe('native')
    expect(events[0]!.decimals).toBeUndefined()
  })

  it('handles a payload with both native and token transfers', async () => {
    const events = await normalizeMoralisEvent({
      chainId: '0x38',
      confirmed: true,
      txs: [{ hash: '0xn', fromAddress: '0xa', toAddress: '0xhw', value: '5' }],
      erc20Transfers: [{ transactionHash: '0xt', from: '0xa', to: '0xhw', value: '5', contract: '0xcontract', tokenSymbol: 'USDT', tokenDecimals: 6 }],
    })
    const native = events.find((e) => e.asset === 'native')
    const token = events.find((e) => e.asset !== 'native')
    expect(native).toBeDefined()
    expect(token?.decimals).toBe(6)
  })
})
