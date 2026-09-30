import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getWorkingRpcUrl, getRpcUrlsInOrder, getExtraRpcUrls, markRpcFailure, orderByRpcHealth } from '../rpcFallback'

const PRIMARY = 'https://primary.example/rpc'
const OK = { ok: true, json: async () => ({ result: '0x10' }) }

let calls: string[] = []
function mockFetch(dead: string[]) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    if (dead.includes(url)) throw new Error('network down')
    return OK
  }))
}

describe('rpcFallback', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete process.env.BSC_RPC_FALLBACK_URLS })

  it('uses the primary when it is healthy', async () => {
    mockFetch([])
    expect(await getWorkingRpcUrl('ARB', PRIMARY)).toBe(PRIMARY)
  })

  it('falls back when the primary is down, then skips it during its cool-down', async () => {
    mockFetch([PRIMARY])
    const url = await getWorkingRpcUrl('OP', PRIMARY)
    expect(url).not.toBe(PRIMARY)
    expect(calls[0]).toBe(PRIMARY) // it was tried first...

    // ...but a second resolution must not wait on the dead primary again.
    vi.advanceTimersByTime(31_000) // past the 30s last-working cache, inside the 60s cool-down
    calls = []
    await getWorkingRpcUrl('OP', PRIMARY)
    expect(calls).not.toContain(PRIMARY)
  })

  it('retries the primary after the cool-down ends', async () => {
    mockFetch([PRIMARY])
    await getWorkingRpcUrl('BASE', PRIMARY)
    mockFetch([]) // primary recovers
    vi.advanceTimersByTime(61_000)
    expect(await getWorkingRpcUrl('BASE', PRIMARY)).toBe(PRIMARY)
  })

  it('accepts operator extras from <CHAIN>_RPC_FALLBACK_URLS, ignoring junk', () => {
    process.env.BSC_RPC_FALLBACK_URLS = 'https://mine.example/bsc, not-a-url ,http://also.example/x,https://mine.example/bsc'
    expect(getExtraRpcUrls('BSC')).toEqual(['https://mine.example/bsc', 'http://also.example/x'])
    const order = getRpcUrlsInOrder('BSC', PRIMARY)
    expect(order[0]).toBe(PRIMARY)
    expect(order[1]).toBe('https://mine.example/bsc') // extras come before the built-in list
    expect(new Set(order).size).toBe(order.length)
  })

  it('moves recently failed endpoints to the back of the order', () => {
    markRpcFailure('https://ethereum-rpc.publicnode.com')
    const order = orderByRpcHealth(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'])
    expect(order).toEqual(['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'])
  })

  it('throws only when every endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(getWorkingRpcUrl('AVAX', PRIMARY)).rejects.toThrow(/All RPC endpoints for AVAX are unreachable/)
  })
})
