import { createPublicClient, http, formatEther } from 'viem'
import { bsc, mainnet } from 'viem/chains'
import { env } from '../env'
import type { GasChainId } from './gas.chains'

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
  viemChain: typeof bsc | typeof mainnet,
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
    case 'BSC':      return getEvmNativeBalance(bsc, env.BSC_RPC_URL, address)
    case 'ETHEREUM': return getEvmNativeBalance(mainnet, env.ETHEREUM_RPC_URL, address)
    default: throw new Error(`getHotWalletBalance: unsupported chain ${chain}`)
  }
}
