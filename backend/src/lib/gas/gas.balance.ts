import type { Chain } from 'viem'
import { createPublicClient, http, formatEther } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { redis } from '../redis'
import { env } from '../env'
import type { GasChainId } from './gas.chains'

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
