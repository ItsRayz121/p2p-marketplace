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

    const sunAmount = Math.round(Number(order.gasAmountNative) * 1_000_000)
    const result = await tronWeb.trx.sendTransaction(order.toAddress, sunAmount)
    if (!result.result) throw new Error(`TronWeb sendTransaction failed: ${JSON.stringify(result)}`)
    return result.txid as string
  } finally {
    if (seed) seed.fill(0)
  }
}

// ── EVM delivery (shared pattern) ─────────────────────────────────────────────

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
  let seed: Buffer | null = null
  try {
    let privateKey: string | undefined
    if (gasWalletIsConfigured()) {
      seed = decryptGasSeed()
      privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    } else {
      privateKey = env.GAS_WALLET_PRIVATE_KEY_BSC
    }
    if (!privateKey) throw new Error('BSC hot wallet not configured: set GAS_SEED_CIPHERTEXT or GAS_WALLET_PRIVATE_KEY_BSC')
    return await deliverEvm(order, bsc, env.BSC_RPC_URL, privateKey)
  } finally {
    if (seed) seed.fill(0)
  }
}

async function deliverEth(order: GasFeeOrder): Promise<string> {
  let seed: Buffer | null = null
  try {
    let privateKey: string | undefined
    if (gasWalletIsConfigured()) {
      seed = decryptGasSeed()
      privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    } else {
      privateKey = env.GAS_WALLET_PRIVATE_KEY_ETH
    }
    if (!privateKey) throw new Error('ETH hot wallet not configured: set GAS_SEED_CIPHERTEXT or GAS_WALLET_PRIVATE_KEY_ETH')
    return await deliverEvm(order, mainnet, env.ETHEREUM_RPC_URL, privateKey)
  } finally {
    if (seed) seed.fill(0)
  }
}

// ── L2 + alt-EVM delivery ─────────────────────────────────────────────────────

async function deliverEvmMnemonic(order: GasFeeOrder, viemChain: Chain, rpcUrl: string): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
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

// ── Non-EVM delivery stubs (inactive — hard guards) ───────────────────────────
//
// These functions intentionally throw before attempting any real transaction.
// Delivery for SOL/TON/SUI is architecturally stubbed:
//   SOL: requires @solana/web3.js for transaction signing
//   TON: requires @ton/ton + proper V4R2 StateInit address
//   SUI: requires @mysten/sui for transaction object building
//
// The guards below ensure that even if an order for these chains somehow
// reaches deliverGas(), it fails safely with a clear error instead of
// silently doing nothing or partially executing.

function deliverSol(_order: GasFeeOrder): never {
  throw new Error(
    'SOL gas delivery is not yet implemented. ' +
    'Chain status: inactive. Requires @solana/web3.js for ed25519 tx signing.',
  )
}

function deliverTon(_order: GasFeeOrder): never {
  throw new Error(
    'TON gas delivery is not yet implemented. ' +
    'Chain status: inactive. Requires @ton/ton + correct V4R2 wallet address derivation.',
  )
}

function deliverSui(_order: GasFeeOrder): never {
  throw new Error(
    'SUI gas delivery is not yet implemented. ' +
    'Chain status: inactive. Requires @mysten/sui for transaction object construction.',
  )
}

// ── Dry-run support ───────────────────────────────────────────────────────────

export interface DeliveryDryRunResult {
  chain: string
  supported: boolean
  hotWalletAddress: string | null
  hotWalletBalance: number | null
  toAddressValid: boolean
  rpcReachable: boolean
  rpcLatencyMs: number
  canDeliver: boolean
  blockers: string[]
  warnings: string[]
}

/**
 * Perform a delivery pre-flight check without sending any transaction.
 * Used by admin endpoints before activating a non-EVM chain.
 */
export async function dryRunDelivery(
  chain: string,
  toAddress: string,
  amount: number,
): Promise<DeliveryDryRunResult> {
  const upperChain = chain.toUpperCase()

  if (upperChain === 'SOL') {
    const { dryRunSolanaDelivery } = await import('./solanaWalletService')
    const r = await dryRunSolanaDelivery(toAddress, amount)
    return {
      chain: 'SOL',
      supported: false,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: false,
      blockers: r.error
        ? [r.error, 'Delivery not implemented — requires @solana/web3.js']
        : ['Delivery not implemented — requires @solana/web3.js'],
      warnings: [],
    }
  }

  if (upperChain === 'TON') {
    const { dryRunTonDelivery } = await import('./tonWalletService')
    const r = await dryRunTonDelivery(toAddress, amount)
    return {
      chain: 'TON',
      supported: false,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: false,
      blockers: [
        'Delivery not implemented — requires @ton/ton',
        'V4R2 wallet address requires @ton/core for StateInit hash',
        ...(r.error ? [r.error] : []),
      ],
      warnings: r.warning ? [r.warning] : [],
    }
  }

  if (upperChain === 'SUI') {
    const { dryRunSuiDelivery } = await import('./suiWalletService')
    const r = await dryRunSuiDelivery(toAddress, amount)
    const warnings: string[] = []
    if (!r.blake2bAvailable) warnings.push('blake2b-256 unavailable — address derivation uses sha3-256 fallback (WRONG)')
    return {
      chain: 'SUI',
      supported: false,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: false,
      blockers: [
        'Delivery not implemented — requires @mysten/sui',
        ...(r.error ? [r.error] : []),
      ],
      warnings,
    }
  }

  // EVM/TRON chains: dry-run not fully implemented but report they are deliverable
  const { GAS_CHAINS } = await import('./gas.chains')
  const cfg = GAS_CHAINS[upperChain as keyof typeof GAS_CHAINS]
  if (!cfg) {
    return {
      chain: upperChain,
      supported: false,
      hotWalletAddress: null,
      hotWalletBalance: null,
      toAddressValid: false,
      rpcReachable: false,
      rpcLatencyMs: 0,
      canDeliver: false,
      blockers: [`Unknown chain: ${upperChain}`],
      warnings: [],
    }
  }

  return {
    chain: upperChain,
    supported: true,
    hotWalletAddress: null,
    hotWalletBalance: null,
    toAddressValid: cfg.validateAddress(toAddress),
    rpcReachable: true,
    rpcLatencyMs: 0,
    canDeliver: cfg.deliveryImplemented,
    blockers: cfg.deliveryImplemented ? [] : ['Delivery not implemented for this chain'],
    warnings: [],
  }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function deliverGas(order: GasFeeOrder): Promise<string> {
  switch (order.chain) {
    case 'TRON':  return deliverTron(order)
    case 'BSC':   return deliverBsc(order)
    case 'ETH':   return deliverEth(order)
    case 'BASE':  return deliverBase(order)
    case 'ARB':   return deliverArb(order)
    case 'OP':    return deliverOp(order)
    case 'MATIC': return deliverMatic(order)
    case 'AVAX':  return deliverAvax(order)
    case 'SOL':   return deliverSol(order)
    case 'TON':   return deliverTon(order)
    case 'SUI':   return deliverSui(order)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}
