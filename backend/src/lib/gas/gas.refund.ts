import type { Decimal } from '@prisma/client/runtime/library'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import type { Chain } from 'viem'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import {
  decryptGasSeed,
  deriveTronPrivateKeyHex,
  deriveEvmPrivateKeyHex,
  HOT_WALLET_INDEX,
} from './gasWalletService'
import { getWorkingRpcUrl, getRpcUrlsInOrder } from './rpcFallback'

// ERC20/BEP20 minimal ABI — only the transfer function we need
const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

// ── USDT contract addresses ───────────────────────────────────────────────────
// All Tether USDT (6 decimals) unless noted.

const USDT_TRC20    = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_BEP20    = '0x55d398326f99059fF775485246999027B3197955' as `0x${string}` // 18 decimals on BSC
const USDT_ERC20    = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as `0x${string}`
const USDT_BASE     = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as `0x${string}`
const USDT_ARB      = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as `0x${string}`
const USDT_OP       = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' as `0x${string}`
const USDT_MATIC    = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' as `0x${string}`
const USDT_AVAX     = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' as `0x${string}`

// BEP20 USDT uses 18 decimals (Binance-pegged). All other EVMs use 6.
const USDT_DECIMALS: Partial<Record<GasChainId, number>> = {
  BSC: 18,
}
function usdtDecimals(chain: GasChainId): number {
  return USDT_DECIMALS[chain] ?? 6
}

// ── TRON TRC20 USDT refund ────────────────────────────────────────────────────

async function sendTrc20UsdtRefund(toAddress: string, amountUsdt: Decimal): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveTronPrivateKeyHex(seed, HOT_WALLET_INDEX)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TronWeb = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULLNODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
      privateKey,
    })

    // USDT TRC20 has 6 decimals
    const sunAmount = Math.round(Number(amountUsdt) * 1_000_000)
    const contract = await tronWeb.contract().at(USDT_TRC20)
    const result = await contract.transfer(toAddress, sunAmount).send()
    if (!result) throw new Error('TronWeb TRC20 transfer returned falsy result')
    return result as string
  } finally {
    seed.fill(0)
  }
}

// ── EVM USDT refund (shared logic) ───────────────────────────────────────────

async function sendEvmUsdtRefund(
  viemChain: Chain,
  rpcUrl: string,
  privateKey: string,
  contractAddress: `0x${string}`,
  decimals: number,
  toAddress: string,
  amountUsdt: Decimal,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
  const amount = parseUnits(Number(amountUsdt).toFixed(decimals), decimals)
  const hash = await client.writeContract({
    account,
    address: contractAddress,
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amount],
  })
  return hash
}

// Helper: derive EVM key, resolve working RPC, send refund, zero seed
async function evmUsdtRefund(
  chain: GasChainId,
  viemChain: Chain,
  primaryRpcUrl: string,
  contractAddress: `0x${string}`,
  toAddress: string,
  amountUsdt: Decimal,
): Promise<string> {
  const rpcUrl = await getWorkingRpcUrl(chain, primaryRpcUrl)
  const seed = decryptGasSeed()
  try {
    const key = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    return await sendEvmUsdtRefund(
      viemChain,
      rpcUrl,
      key,
      contractAddress,
      usdtDecimals(chain),
      toAddress,
      amountUsdt,
    )
  } finally {
    seed.fill(0)
  }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function sendUsdtRefund(
  chain: GasChainId,
  toAddress: string,
  amountUsdt: Decimal,
): Promise<string> {
  switch (chain) {
    case 'TRON':
      return sendTrc20UsdtRefund(toAddress, amountUsdt)
    case 'BSC':
      return evmUsdtRefund(chain, bsc,       env.BSC_RPC_URL,       USDT_BEP20, toAddress, amountUsdt)
    case 'ETHEREUM':
      return evmUsdtRefund(chain, mainnet,   env.ETHEREUM_RPC_URL,  USDT_ERC20, toAddress, amountUsdt)
    case 'BASE':
      return evmUsdtRefund(chain, base,      env.BASE_RPC_URL,      USDT_BASE,  toAddress, amountUsdt)
    case 'ARB':
      return evmUsdtRefund(chain, arbitrum,  env.ARBITRUM_RPC_URL,  USDT_ARB,   toAddress, amountUsdt)
    case 'OP':
      return evmUsdtRefund(chain, optimism,  env.OPTIMISM_RPC_URL,  USDT_OP,    toAddress, amountUsdt)
    case 'MATIC':
      return evmUsdtRefund(chain, polygon,   env.POLYGON_RPC_URL,   USDT_MATIC, toAddress, amountUsdt)
    case 'AVAX':
      return evmUsdtRefund(chain, avalanche, env.AVALANCHE_RPC_URL, USDT_AVAX,  toAddress, amountUsdt)
    default:
      throw new Error(`sendUsdtRefund: unsupported chain ${chain}`)
  }
}

// ── Sender address lookup from tx hash ────────────────────────────────────────
// Used by gasRefund.job when paymentSenderAddress is null (lazy lookup)

async function evmSenderFromTx(
  chain: GasChainId,
  viemChain: Chain,
  primaryRpcUrl: string,
  txHash: string,
): Promise<string | null> {
  // Try the actual tx lookup across every endpoint (primary + free public
  // fallbacks), not just the first node that answers an eth_blockNumber probe.
  // A node can pass the cheap probe yet rate-limit or lag on the tx itself —
  // giving up after one URL was the cause of spurious SENDER_ADDRESS_UNRESOLVABLE.
  const urls = getRpcUrlsInOrder(chain, primaryRpcUrl)
  let lastErr: unknown
  for (const rpcUrl of urls) {
    try {
      const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
      if (tx?.from) return tx.from
    } catch (err) {
      lastErr = err // tx not found on this node (or it errored) — try the next
    }
  }
  if (lastErr) throw lastErr // surfaced to getSenderAddressFromTx's catch → null
  return null
}

export async function getSenderAddressFromTx(
  chain: GasChainId,
  txHash: string,
): Promise<string | null> {
  try {
    switch (chain) {
      case 'TRON': {
        const url = `${env.TRON_FULLNODE_URL}/v1/transactions/${encodeURIComponent(txHash)}`
        const headers: Record<string, string> = {}
        if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) return null
        const data = (await res.json()) as { data?: Array<{ raw_data?: { contract?: Array<{ parameter?: { value?: { owner_address?: string } } }> } }> }
        const ownerHex = data.data?.[0]?.raw_data?.contract?.[0]?.parameter?.value?.owner_address
        if (!ownerHex) return null
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TronWeb = require('tronweb')
        return TronWeb.address.fromHex(ownerHex) as string
      }
      case 'BSC':      return evmSenderFromTx(chain, bsc,       env.BSC_RPC_URL,       txHash)
      case 'ETHEREUM': return evmSenderFromTx(chain, mainnet,   env.ETHEREUM_RPC_URL,  txHash)
      case 'BASE':     return evmSenderFromTx(chain, base,      env.BASE_RPC_URL,      txHash)
      case 'ARB':      return evmSenderFromTx(chain, arbitrum,  env.ARBITRUM_RPC_URL,  txHash)
      case 'OP':       return evmSenderFromTx(chain, optimism,  env.OPTIMISM_RPC_URL,  txHash)
      case 'MATIC':    return evmSenderFromTx(chain, polygon,   env.POLYGON_RPC_URL,   txHash)
      case 'AVAX':     return evmSenderFromTx(chain, avalanche, env.AVALANCHE_RPC_URL, txHash)
      default:
        return null
    }
  } catch {
    return null
  }
}

// ── USDT contract address lookup (for admin display) ─────────────────────────

export function getUsdtContractAddress(chain: GasChainId): string | null {
  switch (chain) {
    case 'TRON':     return USDT_TRC20
    case 'BSC':      return USDT_BEP20
    case 'ETHEREUM': return USDT_ERC20
    case 'BASE':     return USDT_BASE
    case 'ARB':      return USDT_ARB
    case 'OP':       return USDT_OP
    case 'MATIC':    return USDT_MATIC
    case 'AVAX':     return USDT_AVAX
    default:         return null
  }
}
