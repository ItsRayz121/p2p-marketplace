/**
 * Treasury wallet service — sends native gas from treasury to hot wallet.
 *
 * Treasury addresses are derived from the same mnemonic as hot wallets but at
 * separate HD indices (100 for TRON, 101 for EVM). They never sign delivery
 * transactions — their only purpose is holding reserve funds and topping up
 * the hot wallet via admin-initiated or auto-approved refills.
 */

import type { Chain } from 'viem'
import { createWalletClient, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import { EVM_GAS_CHAINS } from './gas.chains'
import {
  decryptGasSeed,
  deriveTronPrivateKeyHex,
  deriveEvmPrivateKeyHex,
  getTronTreasuryAddress,
  getEvmTreasuryAddress,
  TREASURY_TRON_INDEX,
  TREASURY_EVM_INDEX,
} from './gasWalletService'
import { getHotWalletBalance } from './gas.balance'

// ── Address lookup ─────────────────────────────────────────────────────────────

export function getTreasuryAddress(chain: GasChainId): string | null {
  if (chain === 'TRON') return getTronTreasuryAddress()
  if (EVM_GAS_CHAINS.includes(chain)) return getEvmTreasuryAddress()
  return null
}

export interface TreasuryAddresses {
  tron: string | null
  evm: string | null
}

export function getAllTreasuryAddresses(): TreasuryAddresses {
  return {
    tron: getTronTreasuryAddress(),
    evm:  getEvmTreasuryAddress(),
  }
}

// ── Balance ────────────────────────────────────────────────────────────────────

export async function getTreasuryBalance(chain: GasChainId): Promise<number> {
  const addr = getTreasuryAddress(chain)
  if (!addr) throw new Error(`Treasury not configured for chain ${chain}`)
  return getHotWalletBalance(chain, addr)
}

// ── Send native from treasury ──────────────────────────────────────────────────

async function sendTronFromTreasury(toAddress: string, nativeAmount: number): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveTronPrivateKeyHex(seed, TREASURY_TRON_INDEX)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TronWeb } = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULLNODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
      privateKey,
    })

    const sunAmount = Math.round(nativeAmount * 1_000_000)
    const result = await tronWeb.trx.sendTransaction(toAddress, sunAmount)
    if (!result.result) {
      throw new Error(`TronWeb treasury sendTransaction failed: ${JSON.stringify(result)}`)
    }
    return result.txid as string
  } finally {
    seed.fill(0)
  }
}

async function sendEvmFromTreasury(
  viemChain: Chain,
  rpcUrl: string,
  toAddress: string,
  nativeAmount: number,
): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, TREASURY_EVM_INDEX)
    const account = privateKeyToAccount(privateKey)
    const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
    return await client.sendTransaction({
      account,
      to: toAddress as `0x${string}`,
      value: parseEther(nativeAmount.toString()),
    })
  } finally {
    seed.fill(0)
  }
}

/**
 * Send native tokens from the treasury wallet to `toAddress`.
 * Used exclusively by the hot-wallet refill system.
 * Returns the transaction hash on success.
 */
export async function sendNativeFromTreasury(
  chain: GasChainId,
  toAddress: string,
  nativeAmount: number,
): Promise<string> {
  switch (chain) {
    case 'TRON':     return sendTronFromTreasury(toAddress, nativeAmount)
    case 'BSC':      return sendEvmFromTreasury(bsc,       env.BSC_RPC_URL,       toAddress, nativeAmount)
    case 'ETHEREUM': return sendEvmFromTreasury(mainnet,   env.ETHEREUM_RPC_URL,  toAddress, nativeAmount)
    case 'BASE':     return sendEvmFromTreasury(base,      env.BASE_RPC_URL,      toAddress, nativeAmount)
    case 'ARB':      return sendEvmFromTreasury(arbitrum,  env.ARBITRUM_RPC_URL,  toAddress, nativeAmount)
    case 'OP':       return sendEvmFromTreasury(optimism,  env.OPTIMISM_RPC_URL,  toAddress, nativeAmount)
    case 'MATIC':    return sendEvmFromTreasury(polygon,   env.POLYGON_RPC_URL,   toAddress, nativeAmount)
    case 'AVAX':     return sendEvmFromTreasury(avalanche, env.AVALANCHE_RPC_URL, toAddress, nativeAmount)
    default:
      throw new Error(`sendNativeFromTreasury: unsupported chain ${chain}`)
  }
}
