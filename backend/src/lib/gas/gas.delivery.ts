import type { GasFeeOrder } from '@prisma/client'
import type { Chain } from 'viem'
import { createWalletClient, http, parseEther, parseGwei, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { db } from '../prisma'
import { env } from '../env'
import { getHotWalletTokenBalance } from './gas.tokenBalance'
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
  getTonEndpoints,
} from './tonWalletService'
import {
  getSuiHotWalletAddress,
  deriveSuiPrivateKeyForDelivery,
} from './suiWalletService'
import { getAptosHotWalletAddress } from './aptosWalletService'

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
  if (chain === 'APT')  return getAptosHotWalletAddress()
  return getEvmHotWalletAddress()
}

// ── Non-native token delivery (USDT / USDC) ───────────────────────────────────
// EVM chains where ERC-20/BEP-20 token delivery is implemented.
const EVM_TOKEN_CHAINS: Record<string, { chain: Chain; rpc: string }> = {
  BSC:   { chain: bsc,       rpc: env.BSC_RPC_URL },
  ETH:   { chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  BASE:  { chain: base,      rpc: env.BASE_RPC_URL },
  ARB:   { chain: arbitrum,  rpc: env.ARBITRUM_RPC_URL },
  OP:    { chain: optimism,  rpc: env.OPTIMISM_RPC_URL },
  MATIC: { chain: polygon,   rpc: env.POLYGON_RPC_URL },
  AVAX:  { chain: avalanche, rpc: env.AVALANCHE_RPC_URL },
}

/** True when the delivery engine can send a non-native token on this chain. */
export function tokenDeliverySupported(dbChain: string): boolean {
  return dbChain === 'TRON' || dbChain === 'APT' || dbChain in EVM_TOKEN_CHAINS
}

const ERC20_TRANSFER_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

// EVM ERC-20 transfer — same hot-wallet lock + nonce-reuse + gas-bump retry as the
// native EVM path, so concurrent sends from the shared hot wallet can't collide.
async function deliverEvmTokenTransfer(
  order: GasFeeOrder,
  viemChain: Chain,
  rpcUrl: string,
  privateKey: string,
  chainKey: string,
  contract: `0x${string}`,
  decimals: number,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const client = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
  const amount = parseUnits(order.gasAmountNative.toString(), decimals)

  return withHotWalletLock(chainKey, async () => {
    const nonce = await getTransactionCount(rpcUrl, chainKey, account.address, 'pending')
    const MAX_ATTEMPTS = 3
    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const gasBump = attempt > 1 ? { maxFeePerGas: parseGwei(String(10 * 1.2 ** (attempt - 1))) } : {}
        return await client.writeContract({
          account,
          address: contract,
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [order.toAddress as `0x${string}`, amount],
          nonce,
          ...gasBump,
        })
      } catch (err) {
        lastErr = err
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt))
      }
    }
    throw lastErr
  })
}

async function deliverEvmToken(order: GasFeeOrder, contract: string, decimals: number, hdIndex: number): Promise<string> {
  const m = EVM_TOKEN_CHAINS[order.chain]
  if (!m) throw new Error(`deliverEvmToken: unsupported EVM chain ${order.chain}`)
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, hdIndex)
    return await deliverEvmTokenTransfer(order, m.chain, m.rpc, privateKey, order.chain, contract as `0x${string}`, decimals)
  } finally {
    seed.fill(0)
  }
}

// TRON TRC-20 transfer.
async function deliverTronToken(order: GasFeeOrder, contract: string, decimals: number, hdIndex: number): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveTronPrivateKeyHex(seed, hdIndex)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TronWeb } = require('tronweb')
    const tronWeb = new TronWeb({
      fullHost: env.TRON_FULLNODE_URL,
      headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
      privateKey,
    })
    const base10 = BigInt(Math.round(Number(order.gasAmountNative) * 10 ** decimals))
    const c = await tronWeb.contract().at(contract)
    const result = await c.transfer(order.toAddress, base10.toString()).send()
    if (!result) throw new Error('TronWeb TRC20 transfer returned falsy result')
    return result as string
  } finally {
    seed.fill(0)
  }
}

// Aptos fungible-asset transfer (mirrors aptosRefund.sendAptosUsdtRefund).
async function deliverAptosToken(order: GasFeeOrder, contract: string, decimals: number): Promise<string> {
  const { Aptos, AptosConfig, Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')
  const { deriveAptosPrivateKeyForDelivery } = await import('./aptosWalletService')

  const amount = BigInt(Math.round(Number(Number(order.gasAmountNative).toFixed(decimals)) * 10 ** decimals))
  if (amount <= 0n) throw new Error(`deliverAptosToken: non-positive amount for ${order.gasAmountNative}`)

  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer:  env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)

  const seed = decryptGasSeed()
  let privKey: Buffer | null = null
  try {
    privKey = deriveAptosPrivateKeyForDelivery(seed)
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(new Uint8Array(privKey)) })
    const txn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: {
        function: '0x1::primary_fungible_store::transfer',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [contract, order.toAddress, amount],
      },
    })
    const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })
    return pending.hash
  } finally {
    seed.fill(0)
    if (privKey) privKey.fill(0)
  }
}

// Native APT delivery — sends the chain's own coin (APT, 8 decimals / octas).
// Uses 0x1::aptos_account::transfer, which credits APT and auto-creates the
// recipient account if it does not exist yet (a plain coin::transfer would fail
// for a brand-new address). Mirrors the seed-zeroing discipline of the other
// non-EVM senders.
async function deliverAptosNative(order: GasFeeOrder): Promise<string> {
  const { Aptos, AptosConfig, Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')
  const { deriveAptosPrivateKeyForDelivery } = await import('./aptosWalletService')

  const APT_DECIMALS = 8
  // toFixed avoids float drift before scaling APT → octas.
  const amount = BigInt(Math.round(Number(Number(order.gasAmountNative).toFixed(APT_DECIMALS)) * 10 ** APT_DECIMALS))
  if (amount <= 0n) throw new Error(`deliverAptosNative: non-positive amount for ${order.gasAmountNative}`)

  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer:  env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)

  const seed = decryptGasSeed()
  let privKey: Buffer | null = null
  try {
    privKey = deriveAptosPrivateKeyForDelivery(seed)
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(new Uint8Array(privKey)) })
    const txn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: {
        function: '0x1::aptos_account::transfer',
        functionArguments: [order.toAddress, amount],
      },
    })
    const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })
    return pending.hash
  } finally {
    seed.fill(0)
    if (privKey) privKey.fill(0)
  }
}

/**
 * Deliver a non-native token. Reads the hot wallet's live token balance + decimals
 * in one call: the decimals are authoritative (a failed read aborts delivery rather
 * than risk wrong-decimals), and the balance gates against an under-funded wallet.
 */
async function deliverToken(order: GasFeeOrder, contract: string, hdIndex: number): Promise<string> {
  let owner: string | null
  if (order.chain === 'APT') {
    const { getAptosHotWalletAddress } = await import('./aptosWalletService')
    owner = getAptosHotWalletAddress()
  } else {
    owner = getHotWalletAddressForChain(order.chain)
  }
  if (!owner) throw new Error(`deliverToken: no hot wallet address for ${order.chain}`)

  const { balance, decimals } = await getHotWalletTokenBalance(order.chain, contract, owner)
  const needed = Number(order.gasAmountNative)
  if (balance < needed) {
    throw Object.assign(
      new Error(`Insufficient hot wallet token balance on ${order.chain}: have ${balance}, need ${needed} (order ${order.id})`),
      { code: 'INSUFFICIENT_HOT_WALLET_TOKEN_BALANCE', orderId: order.id, chain: order.chain, balance, needed },
    )
  }

  if (order.chain === 'TRON') return deliverTronToken(order, contract, decimals, hdIndex)
  if (order.chain === 'APT')  return deliverAptosToken(order, contract, decimals)
  return deliverEvmToken(order, contract, decimals, hdIndex)
}

/**
 * Verify the hot wallet has enough native balance to cover the delivery amount.
 * Throws an AppError-like Error with code INSUFFICIENT_HOT_WALLET_BALANCE so the
 * job can mark the order as paused and enqueue a refill instead of retrying blindly.
 */
async function assertHotWalletSufficient(order: GasFeeOrder): Promise<void> {
  // Aptos has no GAS_CHAINS / GasHotWallet row — check its derived FA address's
  // native APT balance directly. The hot wallet pays BOTH the delivered amount and
  // the tx gas in APT, so require a small buffer on top.
  if (order.chain === 'APT') {
    const addr = getAptosHotWalletAddress()
    if (!addr) return
    let balance: number
    try {
      const { getAptosNativeBalance } = await import('./aptosRefund')
      balance = await getAptosNativeBalance(addr)
    } catch {
      return // balance read failed (RPC down) — let the delivery attempt proceed
    }
    const required = Number(order.gasAmountNative)
    const needed = required * 1.005 + 0.002 // delivered amount + headroom for the APT gas fee
    if (balance < needed) {
      throw Object.assign(
        new Error(`Insufficient hot wallet balance on APT: have ${balance}, need ${needed} (order ${order.id})`),
        { code: 'INSUFFICIENT_HOT_WALLET_BALANCE', orderId: order.id, chain: 'APT', balance, needed },
      )
    }
    return
  }

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
      headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {},
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
  const { WalletContractV4, TonClient, TonClient4, internal } = await import('@ton/ton')
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
    const value = toNano(Number(order.gasAmountNative).toFixed(9))

    // Signed transfer cell is identical regardless of which provider broadcasts it —
    // it only depends on the seqno. createTransfer lives on the wallet (no provider
    // needed), so build it per attempt with that endpoint's freshly-read seqno.
    const buildTransfer = (seqno: number) =>
      wallet.createTransfer({
        seqno,
        secretKey,
        messages: [internal({ to: order.toAddress, value, bounce: false })],
      })

    // Try each endpoint in order. 1–3 are the toncenter v2 family (operator → orbs →
    // public) and tend to fail together when that backend 5xx's; the 'v4' endpoint is
    // TON Hub's independent infrastructure and is the real survivor of a toncenter
    // outage. getSeqno + send happen on the SAME client per attempt so the seqno
    // stays consistent.
    const endpoints = await getTonEndpoints()
    let lastErr: unknown
    for (const ep of endpoints) {
      try {
        if (ep.kind === 'v4') {
          const client = new TonClient4({ endpoint: ep.jsonRpcUrl, timeout: 15_000 })
          const contract = client.open(wallet)
          const seqno = await contract.getSeqno()
          const transfer = buildTransfer(seqno)
          // External message cell hash — unique identifier usable on Tonscan
          const txHash = transfer.hash().toString('hex')
          await client.sendMessage(transfer.toBoc())
          return txHash
        }

        const client = new TonClient({
          endpoint: ep.jsonRpcUrl,
          ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
        })
        const contract = client.open(wallet)
        const seqno = await contract.getSeqno()
        const transfer = buildTransfer(seqno)
        // External message cell hash — unique identifier usable on Tonscan
        const txHash = transfer.hash().toString('hex')
        await client.sendFile(transfer.toBoc())
        return txHash
      } catch (err) {
        lastErr = err // provider failed — try the next endpoint
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('TON delivery failed on all endpoints')
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
  // Non-native token order? Route to the token-delivery path. The deliveryLive
  // re-check here is belt-and-suspenders: even if an order was created while a
  // token was live, a subsequent take-offline blocks delivery.
  if (order.gasTokenConfigId) {
    const tokenCfg = await db.gasTokenConfig.findUnique({
      where: { id: order.gasTokenConfigId },
      select: { tokenType: true, contractAddress: true, deliveryLive: true, symbol: true },
    })
    // Any non-native token routes to token delivery. Match on !== 'native' (not
    // === 'token') so UI-created tokens carrying named standards (erc20, bep20,
    // trc20, fa, …) are not misrouted to the native-coin delivery path below.
    if (tokenCfg && tokenCfg.tokenType !== 'native') {
      if (!tokenCfg.contractAddress) throw new Error(`deliverGas: token ${tokenCfg.symbol} has no contract address`)
      if (!tokenDeliverySupported(order.chain)) throw new Error(`deliverGas: token delivery not supported on ${order.chain}`)
      if (!tokenCfg.deliveryLive) throw new Error(`deliverGas: token delivery is not live for ${tokenCfg.symbol}`)
      return deliverToken(order, tokenCfg.contractAddress, hdIndex)
    }
  }

  // Pre-flight: confirm hot wallet has enough native balance before sending.
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
    case 'APT':   return deliverAptosNative(order)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}
