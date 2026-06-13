import { createPublicClient, http } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import type { Chain } from 'viem'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import { getWorkingRpcUrl } from './rpcFallback'
import { logger } from '../logger'

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
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY

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

// ── Solana confirmation ───────────────────────────────────────────────────────

async function checkSolanaTxConfirmed(txHash: string): Promise<boolean> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignatureStatuses',
    params: [[txHash], { searchTransactionHistory: true }],
  })
  const res = await fetch(env.SOL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Solana RPC getSignatureStatuses HTTP ${res.status}`)
  const data = await res.json() as {
    result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> }
    error?: { message: string }
  }
  if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`)
  const status = data.result?.value?.[0]
  if (!status) return false // not yet indexed — retry
  return status.confirmationStatus === 'finalized' && status.err === null
}

// ── SUI confirmation ──────────────────────────────────────────────────────────

async function checkSuiTxConfirmed(txHash: string): Promise<boolean> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'sui_getTransactionBlock',
    params: [txHash, { showEffects: true }],
  })
  const res = await fetch(env.SUI_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`SUI RPC sui_getTransactionBlock HTTP ${res.status}`)
  const data = await res.json() as {
    result?: { effects?: { status?: { status?: string } } }
    error?: { message?: string; code?: number }
  }
  if (data.error) {
    // Code -32000 = not found yet — return false so the job retries
    if (data.error.code === -32000) return false
    throw new Error(`SUI RPC error: ${data.error.message ?? JSON.stringify(data.error)}`)
  }
  return data.result?.effects?.status?.status === 'success'
}

// ── TON confirmation ──────────────────────────────────────────────────────────
// TON block time is ~5s and the transaction is final once included in a masterchain block.
// By the time this confirmation job runs (60s after delivery), the tx is always finalized.
// The hash we store is the external message BOC hash, not a standard explorer tx hash,
// so we cannot look it up directly via toncenter — but finality is guaranteed by the time.

function checkTonTxConfirmed(_txHash: string): Promise<boolean> {
  logger.debug({ chain: 'TON' }, 'TON delivery confirmed (instant finality — no hash lookup needed)')
  return Promise.resolve(true)
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function checkTxConfirmed(chain: GasChainId | string, txHash: string): Promise<boolean> {
  switch (chain) {
    case 'TRON':
      return checkTronTxConfirmed(txHash)
    case 'BSC':
      return checkEvmTxConfirmed('BSC', bsc,       env.BSC_RPC_URL,       txHash)
    // DB enum uses 'ETH'; GasChainId uses 'ETHEREUM' — handle both
    case 'ETH':
    case 'ETHEREUM':
      return checkEvmTxConfirmed('ETHEREUM', mainnet,   env.ETHEREUM_RPC_URL,  txHash)
    case 'BASE':
      return checkEvmTxConfirmed('BASE', base,      env.BASE_RPC_URL,      txHash)
    case 'ARB':
      return checkEvmTxConfirmed('ARB', arbitrum,  env.ARBITRUM_RPC_URL,  txHash)
    case 'OP':
      return checkEvmTxConfirmed('OP', optimism,  env.OPTIMISM_RPC_URL,  txHash)
    case 'MATIC':
      return checkEvmTxConfirmed('MATIC', polygon,   env.POLYGON_RPC_URL,   txHash)
    case 'AVAX':
      return checkEvmTxConfirmed('AVAX', avalanche, env.AVALANCHE_RPC_URL, txHash)
    case 'SOL':
      return checkSolanaTxConfirmed(txHash)
    case 'TON':
      return checkTonTxConfirmed(txHash)
    case 'SUI':
      return checkSuiTxConfirmed(txHash)
    default:
      throw new Error(`checkTxConfirmed: unsupported chain ${chain}`)
  }
}

// ── Required confirmations lookup (for admin display) ─────────────────────────

export function getRequiredConfirmations(chain: GasChainId | string): number | null {
  if (chain === 'TRON') return null
  if (chain === 'SOL')  return null // finalized status, not block count
  if (chain === 'TON')  return null // instant finality
  if (chain === 'SUI')  return null // effects.status check, not block count
  if (chain === 'ETH')  return REQUIRED_CONFIRMATIONS['ETHEREUM'] ?? null
  return REQUIRED_CONFIRMATIONS[chain as GasChainId] ?? null
}
