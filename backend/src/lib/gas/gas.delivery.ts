import type { GasFeeOrder } from '@prisma/client'
import { createWalletClient, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc, mainnet } from 'viem/chains'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
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
  viemChain: typeof bsc | typeof mainnet,
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

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function deliverGas(order: GasFeeOrder): Promise<string> {
  switch (order.chain as GasChainId) {
    case 'TRON':     return deliverTron(order)
    case 'BSC':      return deliverBsc(order)
    case 'ETHEREUM': return deliverEth(order)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}
