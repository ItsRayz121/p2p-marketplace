import type { GasFeeOrder } from '@prisma/client'
import type { Chain } from 'viem'
import { createWalletClient, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { env } from '../env'
import {
  gasWalletIsConfigured,
  decryptGasSeed,
  deriveTronPrivateKeyHex,
  deriveEvmPrivateKeyHex,
  HOT_WALLET_INDEX,
} from './gasWalletService'

// ── TRON delivery ─────────────────────────────────────────────────────────────

async function deliverTron(order: GasFeeOrder): Promise<string> {
  // Priority: mnemonic-derived key → legacy GAS_WALLET_PRIVATE_KEY_TRON env var.
  // Both produce the same key as long as the mnemonic matches (verified Phase 1).
  let seed: Buffer | null = null
  try {
    let privateKey: string | undefined
    if (gasWalletIsConfigured()) {
      seed = decryptGasSeed()
      privateKey = deriveTronPrivateKeyHex(seed, HOT_WALLET_INDEX)
    } else {
      privateKey = env.GAS_WALLET_PRIVATE_KEY_TRON
    }

    if (!privateKey) {
      throw new Error(
        'TRON hot wallet not configured: set GAS_SEED_CIPHERTEXT or GAS_WALLET_PRIVATE_KEY_TRON',
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TronWeb } = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULLNODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRONGRID-API-Key': env.TRONGRID_API_KEY } : {},
      privateKey,
    })

    // 1 TRX = 1,000,000 SUN. Math.round avoids float truncation on fractional amounts.
    const sunAmount = Math.round(Number(order.gasAmountNative) * 1_000_000)
    const result = await tronWeb.trx.sendTransaction(order.toAddress, sunAmount)
    if (!result.result) throw new Error(`TronWeb sendTransaction failed: ${JSON.stringify(result)}`)
    return result.txid as string
  } finally {
    if (seed) seed.fill(0)
  }
}

// ── EVM delivery (BSC + ETH share the same viem pattern) ─────────────────────

async function deliverEvm(
  order: GasFeeOrder,
  viemChain: Chain,
  rpcUrl: string,
  privateKey: string,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
  const hash = await client.sendTransaction({
    account,
    to: order.toAddress as `0x${string}`,
    value: parseEther(order.gasAmountNative.toString()),
  })
  return hash
}

async function deliverBsc(order: GasFeeOrder): Promise<string> {
  // Priority: mnemonic-derived key → legacy GAS_WALLET_PRIVATE_KEY_BSC env var.
  let seed: Buffer | null = null
  try {
    let privateKey: string | undefined
    if (gasWalletIsConfigured()) {
      seed = decryptGasSeed()
      privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    } else {
      privateKey = env.GAS_WALLET_PRIVATE_KEY_BSC
    }

    if (!privateKey) {
      throw new Error(
        'BSC hot wallet not configured: set GAS_SEED_CIPHERTEXT or GAS_WALLET_PRIVATE_KEY_BSC',
      )
    }
    return await deliverEvm(order, bsc, env.BSC_RPC_URL, privateKey)
  } finally {
    if (seed) seed.fill(0)
  }
}

async function deliverEth(order: GasFeeOrder): Promise<string> {
  // Priority: mnemonic-derived key → legacy GAS_WALLET_PRIVATE_KEY_ETH env var.
  let seed: Buffer | null = null
  try {
    let privateKey: string | undefined
    if (gasWalletIsConfigured()) {
      seed = decryptGasSeed()
      privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    } else {
      privateKey = env.GAS_WALLET_PRIVATE_KEY_ETH
    }

    if (!privateKey) {
      throw new Error(
        'ETH hot wallet not configured: set GAS_SEED_CIPHERTEXT or GAS_WALLET_PRIVATE_KEY_ETH',
      )
    }
    return await deliverEvm(order, mainnet, env.ETHEREUM_RPC_URL, privateKey)
  } finally {
    if (seed) seed.fill(0)
  }
}

// ── L2 + alt-EVM delivery (Base, Arbitrum, Optimism, Polygon, Avalanche) ─────

async function deliverEvmMnemonic(order: GasFeeOrder, viemChain: Chain, rpcUrl: string): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    if (!privateKey) throw new Error('EVM hot wallet key derivation failed')
    return await deliverEvm(order, viemChain, rpcUrl, privateKey)
  } finally {
    seed.fill(0)
  }
}

async function deliverBase(order: GasFeeOrder): Promise<string> {
  if (!gasWalletIsConfigured()) throw new Error('Base delivery requires GAS_SEED_CIPHERTEXT')
  return deliverEvmMnemonic(order, base, env.BASE_RPC_URL)
}

async function deliverArb(order: GasFeeOrder): Promise<string> {
  if (!gasWalletIsConfigured()) throw new Error('Arbitrum delivery requires GAS_SEED_CIPHERTEXT')
  return deliverEvmMnemonic(order, arbitrum, env.ARBITRUM_RPC_URL)
}

async function deliverOp(order: GasFeeOrder): Promise<string> {
  if (!gasWalletIsConfigured()) throw new Error('Optimism delivery requires GAS_SEED_CIPHERTEXT')
  return deliverEvmMnemonic(order, optimism, env.OPTIMISM_RPC_URL)
}

async function deliverMatic(order: GasFeeOrder): Promise<string> {
  if (!gasWalletIsConfigured()) throw new Error('Polygon delivery requires GAS_SEED_CIPHERTEXT')
  return deliverEvmMnemonic(order, polygon, env.POLYGON_RPC_URL)
}

async function deliverAvax(order: GasFeeOrder): Promise<string> {
  if (!gasWalletIsConfigured()) throw new Error('Avalanche delivery requires GAS_SEED_CIPHERTEXT')
  return deliverEvmMnemonic(order, avalanche, env.AVALANCHE_RPC_URL)
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function deliverGas(order: GasFeeOrder): Promise<string> {
  // order.chain is the DB enum value (e.g. 'ETH', not 'ETHEREUM')
  switch (order.chain) {
    case 'TRON':  return deliverTron(order)
    case 'BSC':   return deliverBsc(order)
    case 'ETH':   return deliverEth(order)
    case 'BASE':  return deliverBase(order)
    case 'ARB':   return deliverArb(order)
    case 'OP':    return deliverOp(order)
    case 'MATIC': return deliverMatic(order)
    case 'AVAX':  return deliverAvax(order)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}
