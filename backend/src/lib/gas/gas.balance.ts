import type { Chain } from 'viem'
import { createPublicClient, http, formatEther } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { redis } from '../redis'
import { env } from '../env'
import type { GasChainId } from './gas.chains'

// ── RPC health result ─────────────────────────────────────────────────────────

export interface RpcHealthResult {
  reachable: boolean
  blockNumber?: number
  latencyMs: number
  error?: string
  /** true when block number hasn't advanced in 5+ min (stale node) */
  isStale?: boolean
}

// ── Native → USD price ────────────────────────────────────────────────────────
// Rates are stored in Redis as PKR values by the rate updater job.
// USD price = pkrRate / usdPkrRate

const CHAIN_PRICE_SYMBOL: Record<GasChainId, string> = {
  TRON: 'TRX', BSC: 'BNB',
  ETHEREUM: 'ETH', BASE: 'ETH', ARB: 'ETH', OP: 'ETH',
  MATIC: 'MATIC', AVAX: 'AVAX',
}

export async function getNativeUsdPrice(chain: GasChainId): Promise<number> {
  const symbol = CHAIN_PRICE_SYMBOL[chain]
  const [usdPkrStr, symbolStr] = await Promise.all([
    redis.get('rate:USD_PKR'),
    redis.get(`rate:${symbol}`),
  ])
  const usdPkr = usdPkrStr ? parseFloat(usdPkrStr) : 0
  const pkrRate = symbolStr ? (JSON.parse(symbolStr) as { rate: number }).rate : 0
  return usdPkr > 0 && pkrRate > 0 ? pkrRate / usdPkr : 0
}

// ── TRON balance ──────────────────────────────────────────────────────────────

async function getTronBalanceTRX(address: string): Promise<number> {
  const url = `${env.TRON_FULLNODE_URL}/v1/accounts/${encodeURIComponent(address)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TronGrid accounts API error: HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Array<{ balance?: number }> }
  const balanceSun = data.data?.[0]?.balance ?? 0
  return balanceSun / 1_000_000 // SUN → TRX
}

// ── EVM native balance via viem ───────────────────────────────────────────────

async function getEvmNativeBalance(
  viemChain: Chain,
  rpcUrl: string,
  address: string,
): Promise<number> {
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })
  const balanceWei = await client.getBalance({ address: address as `0x${string}` })
  return parseFloat(formatEther(balanceWei))
}

// ── RPC health checks ─────────────────────────────────────────────────────────

async function checkEvmRpc(viemChain: Chain, rpcUrl: string): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl, { timeout: 8_000 }) })
    const blockNumber = await client.getBlockNumber()
    const latencyMs = Date.now() - start

    // Stale check: compare to previously cached block number
    const cacheKey = `gas_rpc_block:${viemChain.id}`
    const [prevEntry] = await Promise.all([redis.get(cacheKey)])
    let isStale = false
    if (prevEntry) {
      const { block: prevBlock, ts } = JSON.parse(prevEntry) as { block: number; ts: number }
      const ageMs = Date.now() - ts
      // If 5+ min have passed and block hasn't moved → stale
      if (ageMs > 300_000 && Number(blockNumber) <= prevBlock) isStale = true
    }
    await redis.set(cacheKey, JSON.stringify({ block: Number(blockNumber), ts: Date.now() }), 'EX', 600)

    return { reachable: true, blockNumber: Number(blockNumber), latencyMs, isStale }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

async function checkTronRpc(rpcUrl: string): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const res = await fetch(`${rpcUrl}/wallet/getnowblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
    const data = await res.json() as { block_header?: { raw_data?: { number?: number } } }
    const blockNumber = data?.block_header?.raw_data?.number
    if (typeof blockNumber !== 'number') {
      return { reachable: false, latencyMs, error: 'Invalid response: missing block_header.raw_data.number' }
    }
    const cacheKey = 'gas_rpc_block:tron'
    const prevEntry = await redis.get(cacheKey)
    let isStale = false
    if (prevEntry) {
      const { block: prevBlock, ts } = JSON.parse(prevEntry) as { block: number; ts: number }
      if (Date.now() - ts > 300_000 && blockNumber <= prevBlock) isStale = true
    }
    await redis.set(cacheKey, JSON.stringify({ block: blockNumber, ts: Date.now() }), 'EX', 600)
    return { reachable: true, blockNumber, latencyMs, isStale }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function testRpcHealth(chain: GasChainId): Promise<RpcHealthResult> {
  switch (chain) {
    case 'TRON':     return checkTronRpc(env.TRON_FULLNODE_URL)
    case 'BSC':      return checkEvmRpc(bsc,       env.BSC_RPC_URL)
    case 'ETHEREUM': return checkEvmRpc(mainnet,   env.ETHEREUM_RPC_URL)
    case 'BASE':     return checkEvmRpc(base,      env.BASE_RPC_URL)
    case 'ARB':      return checkEvmRpc(arbitrum,  env.ARBITRUM_RPC_URL)
    case 'OP':       return checkEvmRpc(optimism,  env.OPTIMISM_RPC_URL)
    case 'MATIC':    return checkEvmRpc(polygon,   env.POLYGON_RPC_URL)
    case 'AVAX':     return checkEvmRpc(avalanche, env.AVALANCHE_RPC_URL)
    default: return { reachable: false, latencyMs: 0, error: `Unsupported chain: ${chain}` }
  }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function getHotWalletBalance(chain: GasChainId, address: string): Promise<number> {
  switch (chain) {
    case 'TRON':     return getTronBalanceTRX(address)
    case 'BSC':      return getEvmNativeBalance(bsc,       env.BSC_RPC_URL,       address)
    case 'ETHEREUM': return getEvmNativeBalance(mainnet,   env.ETHEREUM_RPC_URL,  address)
    case 'BASE':     return getEvmNativeBalance(base,      env.BASE_RPC_URL,      address)
    case 'ARB':      return getEvmNativeBalance(arbitrum,  env.ARBITRUM_RPC_URL,  address)
    case 'OP':       return getEvmNativeBalance(optimism,  env.OPTIMISM_RPC_URL,  address)
    case 'MATIC':    return getEvmNativeBalance(polygon,   env.POLYGON_RPC_URL,   address)
    case 'AVAX':     return getEvmNativeBalance(avalanche, env.AVALANCHE_RPC_URL, address)
    default: throw new Error(`getHotWalletBalance: unsupported chain ${chain}`)
  }
}
