import type { GasFeeOrder } from '@prisma/client'
import type { Chain } from 'viem'
import { createWalletClient, http, parseEther, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { env } from '../env'
import {
  decryptGasSeed,
  deriveTronPrivateKeyHex,
  deriveEvmPrivateKeyHex,
  getTronHotWalletAddress,
  getEvmHotWalletAddress,
  HOT_WALLET_INDEX,
} from './gasWalletService'
import { getHotWalletBalance } from './gas.balance'
import { getTransactionCount } from '../evmRpc'
import { withHotWalletLock } from '../hotWalletLock'
import type { GasChainId } from './gas.chains'
import {
  getSolanaHotWalletAddress,
  deriveSolanaPrivateKeyForDelivery,
} from './solanaWalletService'
import {
  getTonHotWalletAddress,
  deriveTonKeypairForDelivery,
} from './tonWalletService'
import {
  getSuiHotWalletAddress,
  deriveSuiPrivateKeyForDelivery,
} from './suiWalletService'

// Map GasFeeOrder.chain (GasChain enum) to GasChainId used by balance helpers.
const CHAIN_TO_BALANCE_ID: Partial<Record<string, GasChainId>> = {
  TRON: 'TRON', BSC: 'BSC', ETH: 'ETHEREUM', BASE: 'BASE',
  ARB: 'ARB', OP: 'OP', MATIC: 'MATIC', AVAX: 'AVAX',
  SOL: 'SOL', TON: 'TON', SUI: 'SUI',
}

function getHotWalletAddressForChain(chain: string): string | null {
  if (chain === 'TRON') return getTronHotWalletAddress()
  if (chain === 'SOL')  return getSolanaHotWalletAddress()
  if (chain === 'TON')  return getTonHotWalletAddress()
  if (chain === 'SUI')  return getSuiHotWalletAddress()
  return getEvmHotWalletAddress()
}

/**
 * Verify the hot wallet has enough native balance to cover the delivery amount.
 * Throws an AppError-like Error with code INSUFFICIENT_HOT_WALLET_BALANCE so the
 * job can mark the order as paused and enqueue a refill instead of retrying blindly.
 */
async function assertHotWalletSufficient(order: GasFeeOrder): Promise<void> {
  const balanceChain = CHAIN_TO_BALANCE_ID[order.chain]
  if (!balanceChain) return

  const hotAddr = getHotWalletAddressForChain(order.chain)
  if (!hotAddr) return

  let balance: number
  try {
    balance = await getHotWalletBalance(balanceChain, hotAddr)
  } catch {
    // If balance check fails (RPC down), skip the guard — let delivery attempt proceed.
    return
  }

  const required = Number(order.gasAmountNative)
  // Allow a small buffer for tx fees (0.5% on top, minimum absolute values are tiny)
  const needed = required * 1.005
  if (balance < needed) {
    throw Object.assign(
      new Error(
        `Insufficient hot wallet balance on ${order.chain}: have ${balance}, need ${needed} (order ${order.id})`,
      ),
      { code: 'INSUFFICIENT_HOT_WALLET_BALANCE', orderId: order.id, chain: order.chain, balance, needed },
    )
  }
}

// ── TRON delivery ─────────────────────────────────────────────────────────────

async function deliverTron(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveTronPrivateKeyHex(seed, hdIndex)

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
    seed.fill(0)
  }
}

// ── EVM delivery (shared pattern) ─────────────────────────────────────────────

// Retry EVM tx up to 3 times with a 20% gas price bump on each attempt.
// Handles transient RPC errors and mempool congestion without blocking indefinitely.
async function deliverEvm(
  order: GasFeeOrder,
  viemChain: Chain,
  rpcUrl: string,
  privateKey: string,
  chainKey: string,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })

  // Serialize per-chain against the withdrawal sender and other deliveries so
  // concurrent broadcasts from the shared hot wallet can't collide on a nonce
  // (see lib/hotWalletLock.ts). The nonce is fetched once inside the lock and
  // REUSED across retries, so a gas-bumped retry replaces the stuck tx rather
  // than queueing a second, higher-nonce send.
  return withHotWalletLock(chainKey, async () => {
    const nonce = await getTransactionCount(rpcUrl, chainKey, account.address, 'pending')

    const MAX_ATTEMPTS = 3
    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // On retries bump maxFeePerGas by 20% per attempt to escape a stuck mempool slot.
        const gasBump = attempt > 1 ? { maxFeePerGas: parseGwei(String(10 * 1.2 ** (attempt - 1))) } : {}
        const hash = await client.sendTransaction({
          account,
          to: order.toAddress as `0x${string}`,
          value: parseEther(order.gasAmountNative.toString()),
          nonce,
          ...gasBump,
        })
        return hash
      } catch (err) {
        lastErr = err
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
    }
    throw lastErr
  })
}

// ── L2 + alt-EVM delivery ─────────────────────────────────────────────────────

async function deliverEvmMnemonic(order: GasFeeOrder, viemChain: Chain, rpcUrl: string, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, hdIndex)
    return await deliverEvm(order, viemChain, rpcUrl, privateKey, order.chain)
  } finally {
    seed.fill(0)
  }
}

async function deliverBsc(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, bsc, env.BSC_RPC_URL, hdIndex)
}

async function deliverEth(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, mainnet, env.ETHEREUM_RPC_URL, hdIndex)
}

async function deliverBase(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, base, env.BASE_RPC_URL, hdIndex)
}

async function deliverArb(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, arbitrum, env.ARBITRUM_RPC_URL, hdIndex)
}

async function deliverOp(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, optimism, env.OPTIMISM_RPC_URL, hdIndex)
}

async function deliverMatic(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, polygon, env.POLYGON_RPC_URL, hdIndex)
}

async function deliverAvax(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  return deliverEvmMnemonic(order, avalanche, env.AVALANCHE_RPC_URL, hdIndex)
}

// ── Solana delivery ───────────────────────────────────────────────────────────

async function deliverSol(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX): Promise<string> {
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } =
    await import('@solana/web3.js')

  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSolanaPrivateKeyForDelivery(seed)
    const keypair = Keypair.fromSeed(new Uint8Array(privateKeySeed))
    const connection = new Connection(env.SOL_RPC_URL, 'confirmed')

    const toPubkey = new PublicKey(order.toAddress)
    const lamports = Math.round(Number(order.gasAmountNative) * LAMPORTS_PER_SOL)

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: keypair.publicKey,
    }).add(SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey,
      lamports,
    }))

    tx.sign(keypair)
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })
    return signature
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
}

// ── TON delivery ──────────────────────────────────────────────────────────────

async function deliverTon(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX): Promise<string> {
  const { WalletContractV4, TonClient, internal } = await import('@ton/ton')
  const { toNano } = await import('@ton/core')

  const seed = decryptGasSeed()
  let privateKey: Buffer | null = null
  try {
    const keypair = deriveTonKeypairForDelivery(seed)
    privateKey = keypair.privateKey
    const { publicKey } = keypair

    // TON nacl-style secret key: private (32 bytes) || public (32 bytes)
    const secretKey = Buffer.concat([privateKey, Buffer.from(publicKey)])

    const wallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(publicKey) })
    const endpoint = `${env.TON_ENDPOINT_URL.replace(/\/$/, '')}/api/v2/jsonRPC`
    const client = new TonClient({
      endpoint,
      ...(env.TON_API_KEY ? { apiKey: env.TON_API_KEY } : {}),
    })
    const contract = client.open(wallet)

    const seqno = await contract.getSeqno()
    const value = toNano(Number(order.gasAmountNative).toFixed(9))

    const transfer = contract.createTransfer({
      seqno,
      secretKey,
      messages: [
        internal({
          to: order.toAddress,
          value,
          bounce: false,
        }),
      ],
    })

    // External message cell hash — unique identifier usable on Tonscan
    const txHash = transfer.hash().toString('hex')
    await client.sendFile(transfer.toBoc())
    return txHash
  } finally {
    seed.fill(0)
    if (privateKey) privateKey.fill(0)
  }
}

// ── SUI delivery ──────────────────────────────────────────────────────────────

async function deliverSui(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX): Promise<string> {
  const { SuiClient } = await import('@mysten/sui/client')
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { Transaction } = await import('@mysten/sui/transactions')

  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSuiPrivateKeyForDelivery(seed)
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(privateKeySeed))
    const client = new SuiClient({ url: env.SUI_RPC_URL })

    const mistAmount = BigInt(Math.round(Number(order.gasAmountNative) * 1e9))
    const tx = new Transaction()
    const [coin] = tx.splitCoins(tx.gas, [mistAmount])
    tx.transferObjects([coin], order.toAddress)

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      requestType: 'WaitForLocalExecution',
      options: { showEffects: true },
    })
    return result.digest
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
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
      supported: true,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: r.ok,
      blockers: r.error ? [r.error] : [],
      warnings: [],
    }
  }

  if (upperChain === 'TON') {
    const { dryRunTonDelivery } = await import('./tonWalletService')
    const r = await dryRunTonDelivery(toAddress, amount)
    return {
      chain: 'TON',
      supported: true,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: r.ok,
      blockers: r.error ? [r.error] : [],
      warnings: r.warning ? [r.warning] : [],
    }
  }

  if (upperChain === 'SUI') {
    const { dryRunSuiDelivery } = await import('./suiWalletService')
    const r = await dryRunSuiDelivery(toAddress, amount)
    const warnings: string[] = []
    if (!r.blake2bAvailable) warnings.push('blake2b-256 unavailable — SUI address is wrong, delivery blocked')
    return {
      chain: 'SUI',
      supported: true,
      hotWalletAddress: r.hotWalletAddress,
      hotWalletBalance: r.hotWalletBalance,
      toAddressValid: r.toAddressValid,
      rpcReachable: r.rpc.reachable,
      rpcLatencyMs: r.rpc.latencyMs,
      canDeliver: r.ok && r.blake2bAvailable,
      blockers: [
        ...(r.error ? [r.error] : []),
        ...(!r.blake2bAvailable ? ['blake2b-256 unavailable on this host — SUI address derivation incorrect'] : []),
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

// Error normalization lives in gas.deliveryError.ts (no heavy chain imports) so
// it can be unit-tested without pulling in the whole wallet/RPC module graph.
export { describeDeliveryError } from './gas.deliveryError'
export type { NormalizedDeliveryError } from './gas.deliveryError'

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function deliverGas(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX): Promise<string> {
  // Pre-flight: confirm hot wallet has enough balance before sending.
  await assertHotWalletSufficient(order)

  switch (order.chain) {
    case 'TRON':  return deliverTron(order, hdIndex)
    case 'BSC':   return deliverBsc(order, hdIndex)
    case 'ETH':   return deliverEth(order, hdIndex)
    case 'BASE':  return deliverBase(order, hdIndex)
    case 'ARB':   return deliverArb(order, hdIndex)
    case 'OP':    return deliverOp(order, hdIndex)
    case 'MATIC': return deliverMatic(order, hdIndex)
    case 'AVAX':  return deliverAvax(order, hdIndex)
    case 'SOL':   return deliverSol(order, hdIndex)
    case 'TON':   return deliverTon(order, hdIndex)
    case 'SUI':   return deliverSui(order, hdIndex)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}
