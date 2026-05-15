import type { Decimal } from '@prisma/client/runtime/library'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, mainnet } from 'viem/chains'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import {
  decryptGasSeed,
  deriveTronPrivateKeyHex,
  deriveEvmPrivateKeyHex,
  HOT_WALLET_INDEX,
} from './gasWalletService'

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

// USDT contract addresses
const USDT_TRC20    = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_BEP20    = '0x55d398326f99059fF775485246999027B3197955' as `0x${string}`
const USDT_ERC20    = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as `0x${string}`

// ── TRON TRC20 USDT refund ────────────────────────────────────────────────────

async function sendTrc20UsdtRefund(toAddress: string, amountUsdt: Decimal): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveTronPrivateKeyHex(seed, HOT_WALLET_INDEX)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TronWeb = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULLNODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
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

// ── EVM USDT refund (BEP20 / ERC20) ──────────────────────────────────────────

async function sendEvmUsdtRefund(
  viemChain: typeof bsc | typeof mainnet,
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

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function sendUsdtRefund(
  chain: GasChainId,
  toAddress: string,
  amountUsdt: Decimal,
): Promise<string> {
  switch (chain) {
    case 'TRON':
      return sendTrc20UsdtRefund(toAddress, amountUsdt)
    case 'BSC': {
      const seed = decryptGasSeed()
      try {
        const key = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
        return await sendEvmUsdtRefund(bsc, env.BSC_RPC_URL, key, USDT_BEP20, 18, toAddress, amountUsdt)
      } finally {
        seed.fill(0)
      }
    }
    case 'ETHEREUM': {
      const seed = decryptGasSeed()
      try {
        const key = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
        return await sendEvmUsdtRefund(mainnet, env.ETHEREUM_RPC_URL, key, USDT_ERC20, 6, toAddress, amountUsdt)
      } finally {
        seed.fill(0)
      }
    }
    default:
      throw new Error(`sendUsdtRefund: unsupported chain ${chain}`)
  }
}

// ── Sender address lookup from tx hash ────────────────────────────────────────
// Used by gasRefund.job when paymentSenderAddress is null (lazy lookup)

export async function getSenderAddressFromTx(
  chain: GasChainId,
  txHash: string,
): Promise<string | null> {
  try {
    switch (chain) {
      case 'TRON': {
        const url = `${env.TRON_FULLNODE_URL}/v1/transactions/${encodeURIComponent(txHash)}`
        const headers: Record<string, string> = {}
        if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) return null
        const data = (await res.json()) as { data?: Array<{ raw_data?: { contract?: Array<{ parameter?: { value?: { owner_address?: string } } }> } }> }
        const ownerHex = data.data?.[0]?.raw_data?.contract?.[0]?.parameter?.value?.owner_address
        if (!ownerHex) return null
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TronWeb = require('tronweb')
        return TronWeb.address.fromHex(ownerHex) as string
      }
      case 'BSC':
      case 'ETHEREUM': {
        const viemChain = chain === 'BSC' ? bsc : mainnet
        const rpcUrl = chain === 'BSC' ? env.BSC_RPC_URL : env.ETHEREUM_RPC_URL
        const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })
        const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
        return tx?.from ?? null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

