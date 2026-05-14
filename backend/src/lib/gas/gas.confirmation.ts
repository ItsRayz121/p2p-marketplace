import { createPublicClient, http } from 'viem'
import { bsc, mainnet } from 'viem/chains'
import { env } from '../env'
import type { GasChainId } from './gas.chains'

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
  viemChain: typeof bsc | typeof mainnet,
  rpcUrl: string,
  txHash: string,
  requiredConfirmations: number,
): Promise<boolean> {
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
  if (!receipt || receipt.status !== 'success') return false

  const block = await client.getBlockNumber()
  const confirmations = Number(block) - Number(receipt.blockNumber)
  return confirmations >= requiredConfirmations
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function checkTxConfirmed(chain: GasChainId, txHash: string): Promise<boolean> {
  switch (chain) {
    case 'TRON':     return checkTronTxConfirmed(txHash)
    case 'BSC':      return checkEvmTxConfirmed(bsc, env.BSC_RPC_URL, txHash, 15)
    case 'ETHEREUM': return checkEvmTxConfirmed(mainnet, env.ETHEREUM_RPC_URL, txHash, 12)
    default: throw new Error(`checkTxConfirmed: unsupported chain ${chain}`)
  }
}
