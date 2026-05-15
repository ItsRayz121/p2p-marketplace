import { createPublicClient, http } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import type { Chain } from 'viem'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import { getWorkingRpcUrl } from './rpcFallback'

// ── Required confirmations per chain ─────────────────────────────────────────
// L2s finalize quickly; ETH mainnet needs more. TRON uses its own polling.

const REQUIRED_CONFIRMATIONS: Partial<Record<GasChainId, number>> = {
  ETHEREUM: 12,
  BSC:      15,
  BASE:     3,
  ARB:      3,
  OP:       3,
  MATIC:    5,
  AVAX:     3,
}

// ── TRON confirmation ─────────────────────────────────────────────────────────

async function checkTronTxConfirmed(txHash: string): Promise<boolean> {
  const url = `${env.TRON_FULLNODE_URL}/v1/transactions/${encodeURIComponent(txHash)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TronGrid API error: HTTP ${res.status}`)

  const data = (await res.json()) as {
    data?: Array<{ ret?: Array<{ contractRet?: string }> }>
  }
  return data.data?.[0]?.ret?.[0]?.contractRet === 'SUCCESS'
}

// ── EVM confirmation via viem ─────────────────────────────────────────────────

async function checkEvmTxConfirmed(
  chain: GasChainId,
  viemChain: Chain,
  primaryRpcUrl: string,
  txHash: string,
): Promise<boolean> {
  const required = REQUIRED_CONFIRMATIONS[chain] ?? 3
  const rpcUrl = await getWorkingRpcUrl(chain, primaryRpcUrl)
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })

  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
  if (!receipt || receipt.status !== 'success') return false

  const block = await client.getBlockNumber()
  const confirmations = Number(block) - Number(receipt.blockNumber)
  return confirmations >= required
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function checkTxConfirmed(chain: GasChainId, txHash: string): Promise<boolean> {
  switch (chain) {
    case 'TRON':
      return checkTronTxConfirmed(txHash)
    case 'BSC':
      return checkEvmTxConfirmed(chain, bsc,       env.BSC_RPC_URL,       txHash)
    case 'ETHEREUM':
      return checkEvmTxConfirmed(chain, mainnet,   env.ETHEREUM_RPC_URL,  txHash)
    case 'BASE':
      return checkEvmTxConfirmed(chain, base,      env.BASE_RPC_URL,      txHash)
    case 'ARB':
      return checkEvmTxConfirmed(chain, arbitrum,  env.ARBITRUM_RPC_URL,  txHash)
    case 'OP':
      return checkEvmTxConfirmed(chain, optimism,  env.OPTIMISM_RPC_URL,  txHash)
    case 'MATIC':
      return checkEvmTxConfirmed(chain, polygon,   env.POLYGON_RPC_URL,   txHash)
    case 'AVAX':
      return checkEvmTxConfirmed(chain, avalanche, env.AVALANCHE_RPC_URL, txHash)
    default:
      throw new Error(`checkTxConfirmed: unsupported chain ${chain}`)
  }
}

// ── Required confirmations lookup (for admin display) ─────────────────────────

export function getRequiredConfirmations(chain: GasChainId): number | null {
  if (chain === 'TRON') return null // TRON uses SUCCESS contractRet, not block count
  return REQUIRED_CONFIRMATIONS[chain] ?? null
}
