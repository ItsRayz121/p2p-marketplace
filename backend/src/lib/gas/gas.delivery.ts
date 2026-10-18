import type { GasFeeOrder } from '@prisma/client'
import type { Chain } from 'viem'
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, opBNB, optimism, polygon } from 'viem/chains'
import { db } from '../prisma'
import { logger } from '../logger'
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
import { getWorkingRpcUrl, getRpcUrlsInOrder } from './rpcFallback'
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
  getSuiRpcEndpoints,
} from './suiWalletService'
import { getAptosHotWalletAddress } from './aptosWalletService'

// Map GasFeeOrder.chain (GasChain enum) to GasChainId used by balance helpers.
const CHAIN_TO_BALANCE_ID: Partial<Record<string, GasChainId>> = {
  TRON: 'TRON', BSC: 'BSC', OPBNB: 'OPBNB', ETH: 'ETHEREUM', BASE: 'BASE',
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
  OPBNB: { chain: opBNB,     rpc: env.OPBNB_RPC_URL },
  ETH:   { chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  BASE:  { chain: base,      rpc: env.BASE_RPC_URL },
  ARB:   { chain: arbitrum,  rpc: env.ARBITRUM_RPC_URL },
  OP:    { chain: optimism,  rpc: env.OPTIMISM_RPC_URL },
  MATIC: { chain: polygon,   rpc: env.POLYGON_RPC_URL },
  AVAX:  { chain: avalanche, rpc: env.AVALANCHE_RPC_URL },
}

/** True when the delivery engine can send a non-native token on this chain. */
export function tokenDeliverySupported(dbChain: string): boolean {
  return dbChain === 'TRON' || dbChain === 'APT' || dbChain === 'SOL' || dbChain === 'SUI' || dbChain in EVM_TOKEN_CHAINS
}

const ERC20_TRANSFER_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/**
 * Written BEFORE a tx is broadcast. After this resolves the delivery may already be on its
 * way, so the order must never be paid again automatically (see gas.attemptRules.ts).
 */
export type DeliveryJournal = (attempt: { txHash: string; nonce?: number; from?: string }) => Promise<void>

// A tx priced at the bare minimum can sit unmined for hours when the base fee rises, and then
// blocks every later send from the same wallet (same nonce queue). Price with real headroom:
// max fee = 2x the current base fee + tip, and a sane minimum tip on Ethereum mainnet.
const MIN_TIP_WEI: Record<number, bigint> = { 1: 1_500_000_000n }

async function pickEip1559Fees(
  pub: ReturnType<typeof createPublicClient>,
  viemChain: Chain,
): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  try {
    const block = await pub.getBlock({ blockTag: 'latest' })
    // Legacy-gas chain, or a chain with a zero base fee (BSC): viem's default pricing is fine.
    if (block.baseFeePerGas == null || block.baseFeePerGas === 0n) return {}
    const est = await pub.estimateFeesPerGas({ chain: viemChain, type: 'eip1559' } as never) as { maxPriorityFeePerGas?: bigint }
    const floor = MIN_TIP_WEI[viemChain.id] ?? 0n
    let tip = est.maxPriorityFeePerGas ?? 0n
    if (tip < floor) tip = floor
    return { maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas * 2n + tip }
  } catch (err) {
    logger.warn({ err, chain: viemChain.name }, 'fee headroom lookup failed — using viem default fees')
    return {}
  }
}

async function relayToOtherNodes(viemChain: Chain, usedUrl: string, serialized: `0x${string}`): Promise<void> {
  const id = (Object.entries(EVM_TOKEN_CHAINS).find(([, v]) => v.chain.id === viemChain.id)?.[0]) ?? null
  if (!id) return
  const urls = getRpcUrlsInOrder(id === 'ETH' ? 'ETHEREUM' : (id as GasChainId), EVM_TOKEN_CHAINS[id]!.rpc)
    .filter((u) => u !== usedUrl).slice(0, 2)
  await Promise.all(urls.map(async (url) => {
    try {
      await createPublicClient({ chain: viemChain, transport: http(url, { timeout: 8_000, retryCount: 0 }) })
        .sendRawTransaction({ serializedTransaction: serialized })
    } catch { /* "already known" / nonce errors are expected and harmless — same tx */ }
  }))
}

/**
 * Sign locally -> journal the deterministic hash -> broadcast ONCE. Preparing/signing happens
 * before anything leaves the process, so those steps may be retried freely. The broadcast is
 * never retried or re-priced: an ambiguous broadcast error (timeout after the node accepted
 * the tx) still returns the journaled hash and the verifier decides what happened.
 */
async function signJournalBroadcast(args: {
  viemChain: Chain
  rpcUrl: string
  account: ReturnType<typeof privateKeyToAccount>
  tx: { to: `0x${string}`; value?: bigint; data?: `0x${string}` }
  nonce: number
  /** Retry after a stuck/cancelled attempt: pay the higher, reliable fee. First attempts use the normal low fee. */
  highFee?: boolean
  journal?: DeliveryJournal
}): Promise<string> {
  const { viemChain, rpcUrl, account, tx, nonce, journal, highFee } = args
  const wallet = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
  const pub = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })

  let serialized: `0x${string}` | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3 && !serialized; attempt++) {
    try {
      const fees = highFee ? await pickEip1559Fees(pub, viemChain) : {}
      const prepared = await wallet.prepareTransactionRequest({ account, chain: viemChain, nonce, ...fees, ...tx } as never)
      serialized = await wallet.signTransaction(prepared as never)
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  if (!serialized) throw lastErr

  const hash = keccak256(serialized)
  if (journal) await journal({ txHash: hash, nonce, from: account.address })
  try {
    await pub.sendRawTransaction({ serializedTransaction: serialized })
  } catch (err) {
    logger.warn({ err, txHash: hash, chain: viemChain.name }, 'Delivery broadcast returned an error — outcome unknown, hash journaled for verification')
  }
  // Also hand the SAME signed tx (same hash, same nonce — it can only ever execute once) to a few
  // independent nodes, so one node that accepts but never propagates cannot strand the delivery.
  await relayToOtherNodes(viemChain, rpcUrl, serialized)
  return hash
}

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
  journal?: DeliveryJournal,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const amount = parseUnits(order.gasAmountNative.toString(), decimals)
  const data = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [order.toAddress as `0x${string}`, amount] })

  return withHotWalletLock(chainKey, async () => {
    const nonce = await getTransactionCount(rpcUrl, chainKey, account.address, 'pending')
    return signJournalBroadcast({ viemChain, rpcUrl, account, tx: { to: contract, data }, nonce, highFee: order.retryCount > 0, ...(journal ? { journal } : {}) })
  })
}

async function deliverEvmToken(order: GasFeeOrder, contract: string, decimals: number, hdIndex: number, journal?: DeliveryJournal): Promise<string> {
  const m = EVM_TOKEN_CHAINS[order.chain]
  if (!m) throw new Error(`deliverEvmToken: unsupported EVM chain ${order.chain}`)
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, hdIndex)
    // Resolve a working endpoint (primary -> operator extras -> public fallbacks) so a dead
    // primary can't strand a paid token-gas order.
    const rpc = await getWorkingRpcUrl(order.chain === 'ETH' ? 'ETHEREUM' : (order.chain as GasChainId), m.rpc)
    return await deliverEvmTokenTransfer(order, m.chain, rpc, privateKey, order.chain, contract as `0x${string}`, decimals, journal)
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
/**
 * Sign -> journal the deterministic tx hash -> submit ONCE. The Aptos user-tx hash is fixed once
 * the tx is signed, so it is journaled before anything is sent. Ambiguous submit errors still
 * return the journaled hash (the verifier decides); the wait runs inside the caller's hot-wallet
 * lock so the next send sees the advanced sequence number, and its errors are never fatal.
 */
async function submitAptosJournaled(
  aptos: import('@aptos-labs/ts-sdk').Aptos,
  account: import('@aptos-labs/ts-sdk').Account,
  txn: import('@aptos-labs/ts-sdk').SimpleTransaction,
  journal?: DeliveryJournal,
): Promise<string> {
  const { generateUserTransactionHash } = await import('@aptos-labs/ts-sdk')
  const senderAuthenticator = aptos.transaction.sign({ signer: account, transaction: txn })
  const hash = generateUserTransactionHash({ transaction: txn, senderAuthenticator })
  if (journal) await journal({ txHash: hash, nonce: Number(txn.rawTransaction.sequence_number) })
  try {
    await aptos.transaction.submit.simple({ transaction: txn, senderAuthenticator })
  } catch (err) {
    logger.warn({ err, txHash: hash }, 'Aptos delivery submit returned an error — outcome unknown, hash journaled for verification')
  }
  await aptos.waitForTransaction({ transactionHash: hash, options: { timeoutSecs: 30, checkSuccess: false } }).catch(() => undefined)
  return hash
}

async function deliverAptosToken(order: GasFeeOrder, contract: string, decimals: number, journal?: DeliveryJournal): Promise<string> {
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
    // Serialize every send from the shared Aptos hot-wallet account (gas delivery,
    // gas refunds, user withdrawals) so concurrent sends can't collide on the
    // account sequence number. Same mutex key the withdrawal sender uses.
    return await withHotWalletLock('aptos', async () => {
      const txn = await aptos.transaction.build.simple({
        sender: account.accountAddress,
        data: {
          function: '0x1::primary_fungible_store::transfer',
          typeArguments: ['0x1::fungible_asset::Metadata'],
          functionArguments: [contract, order.toAddress, amount],
        },
      })
      return submitAptosJournaled(aptos, account, txn, journal)
    })
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
async function deliverAptosNative(order: GasFeeOrder, journal?: DeliveryJournal): Promise<string> {
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
    // Shared Aptos hot-wallet mutex — see deliverAptosToken.
    return await withHotWalletLock('aptos', async () => {
      const txn = await aptos.transaction.build.simple({
        sender: account.accountAddress,
        data: {
          function: '0x1::aptos_account::transfer',
          functionArguments: [order.toAddress, amount],
        },
      })
      return submitAptosJournaled(aptos, account, txn, journal)
    })
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
async function deliverToken(order: GasFeeOrder, contract: string, hdIndex: number, journal?: DeliveryJournal): Promise<string> {
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
  if (order.chain === 'APT')  return deliverAptosToken(order, contract, decimals, journal)
  if (order.chain === 'SOL')  return deliverSolToken(order, contract, decimals, journal)
  if (order.chain === 'SUI')  return deliverSuiToken(order, contract, decimals, journal)
  return deliverEvmToken(order, contract, decimals, hdIndex, journal)
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

// Native EVM send. The nonce is read once inside the per-chain hot-wallet lock (see
// lib/hotWalletLock.ts), the signed tx is journaled, then broadcast exactly once.
async function deliverEvm(
  order: GasFeeOrder,
  viemChain: Chain,
  rpcUrl: string,
  privateKey: string,
  chainKey: string,
  journal?: DeliveryJournal,
): Promise<string> {
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  return withHotWalletLock(chainKey, async () => {
    const nonce = await getTransactionCount(rpcUrl, chainKey, account.address, 'pending')
    return signJournalBroadcast({
      viemChain, rpcUrl, account, nonce, highFee: order.retryCount > 0,
      tx: { to: order.toAddress as `0x${string}`, value: parseEther(order.gasAmountNative.toString()) },
      ...(journal ? { journal } : {}),
    })
  })
}

// ── L2 + alt-EVM delivery ─────────────────────────────────────────────────────

async function deliverEvmMnemonic(order: GasFeeOrder, viemChain: Chain, rpcUrl: string, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, hdIndex)
    return await deliverEvm(order, viemChain, rpcUrl, privateKey, order.chain, journal)
  } finally {
    seed.fill(0)
  }
}

async function deliverBsc(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, bsc, await getWorkingRpcUrl('BSC', env.BSC_RPC_URL), hdIndex, journal)
}

async function deliverOpBnb(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, opBNB, await getWorkingRpcUrl('OPBNB', env.OPBNB_RPC_URL), hdIndex, journal)
}

async function deliverEth(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, mainnet, await getWorkingRpcUrl('ETHEREUM', env.ETHEREUM_RPC_URL), hdIndex, journal)
}

async function deliverBase(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, base, await getWorkingRpcUrl('BASE', env.BASE_RPC_URL), hdIndex, journal)
}

async function deliverArb(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, arbitrum, await getWorkingRpcUrl('ARB', env.ARBITRUM_RPC_URL), hdIndex, journal)
}

async function deliverOp(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, optimism, await getWorkingRpcUrl('OP', env.OPTIMISM_RPC_URL), hdIndex, journal)
}

async function deliverMatic(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, polygon, await getWorkingRpcUrl('MATIC', env.POLYGON_RPC_URL), hdIndex, journal)
}

async function deliverAvax(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  return deliverEvmMnemonic(order, avalanche, await getWorkingRpcUrl('AVAX', env.AVALANCHE_RPC_URL), hdIndex, journal)
}

// ── Solana delivery ───────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)]! + out; n /= 58n }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break }
  return out
}

// The signature is fixed once the tx is signed, so it is journaled BEFORE broadcast.
// The broadcast happens once; an ambiguous error still returns the journaled signature.
async function journalAndSendSolana(
  connection: { sendRawTransaction: (raw: Buffer | Uint8Array, opts?: { skipPreflight?: boolean; preflightCommitment?: 'confirmed' }) => Promise<string> },
  tx: { signature: Buffer | null; serialize: () => Buffer },
  journal?: DeliveryJournal,
): Promise<string> {
  if (!tx.signature) throw new Error('Solana delivery: transaction has no signature')
  const signature = base58(tx.signature)
  if (journal) await journal({ txHash: signature })
  try {
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
  } catch (err) {
    logger.warn({ err, txHash: signature }, 'Solana delivery broadcast returned an error — outcome unknown, signature journaled for verification')
  }
  return signature
}

async function deliverSol(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
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
    return await journalAndSendSolana(connection, tx, journal)
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
}

// SPL token transfer (USDT / USDC on Solana). Sends from the hot wallet's token
// account holding the largest balance for the mint (funding via a plain wallet
// transfer lands in the ATA, but don't assume) and creates the recipient's
// associated token account when missing — the hot wallet pays the ~0.002 SOL rent.
async function deliverSolToken(order: GasFeeOrder, mintAddress: string, decimals: number, journal?: DeliveryJournal): Promise<string> {
  const { Connection, Keypair, PublicKey, Transaction } = await import('@solana/web3.js')
  const {
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
  } = await import('@solana/spl-token')

  // toFixed avoids float drift before scaling to base units (mirrors the Aptos path).
  const amount = BigInt(Math.round(Number(Number(order.gasAmountNative).toFixed(decimals)) * 10 ** decimals))
  if (amount <= 0n) throw new Error(`deliverSolToken: non-positive amount for ${order.gasAmountNative}`)

  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSolanaPrivateKeyForDelivery(seed)
    const keypair = Keypair.fromSeed(new Uint8Array(privateKeySeed))
    const connection = new Connection(env.SOL_RPC_URL, 'confirmed')

    const mint = new PublicKey(mintAddress)
    const recipient = new PublicKey(order.toAddress)

    // Classic SPL and Token-2022 mints live under different token programs — read
    // the mint's owner so ATA derivation and the transfer target the right one.
    const mintInfo = await connection.getAccountInfo(mint)
    if (!mintInfo) throw new Error(`deliverSolToken: mint ${mintAddress} not found on-chain`)
    const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

    const accts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint })
    let source = getAssociatedTokenAddressSync(mint, keypair.publicKey, false, programId)
    let sourceBalance = -1n
    for (const { pubkey, account } of accts.value) {
      const raw = BigInt(account.data.parsed?.info?.tokenAmount?.amount ?? '0')
      if (raw > sourceBalance) { sourceBalance = raw; source = pubkey }
    }
    if (sourceBalance < amount) {
      // deliverToken() already gated on the aggregate balance, so this only fires
      // when funds are fragmented across token accounts — surface it clearly.
      throw new Error(`deliverSolToken: largest hot-wallet token account holds ${sourceBalance < 0n ? 0n : sourceBalance} base units, need ${amount}`)
    }

    // allowOwnerOffCurve so PDA recipients (e.g. exchange deposit addresses) work.
    const destAta = getAssociatedTokenAddressSync(mint, recipient, true, programId)
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey })
      .add(createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, destAta, recipient, mint, programId))
      .add(createTransferCheckedInstruction(source, mint, destAta, keypair.publicKey, amount, decimals, [], programId))

    tx.sign(keypair)
    return await journalAndSendSolana(connection, tx, journal)
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
}

// ── TON delivery ──────────────────────────────────────────────────────────────

async function deliverTon(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
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

    // The endpoints (toncenter v2 family, then TON Hub v4) fail independently, so BOTH phases fail
    // over — but only the READ phase may build a message. Flow:
    //   1. read the wallet seqno (read-only, any endpoint)        — safe to retry
    //   2. build + sign ONE transfer for that seqno                — fixes the message hash
    //   3. journal the hash (+ seqno) BEFORE anything is sent
    //   4. send that IDENTICAL message, failing over across endpoints. The wallet contract
    //      executes a given seqno once, so re-sending identical bytes can never pay twice.
    // contract.send() wraps the body into a full external message and attaches the wallet
    // StateInit when the account is not deployed yet (a raw sendFile of the body would 406).
    const endpoints = await getTonEndpoints()
    const open = (ep: (typeof endpoints)[number]) => {
      const client =
        ep.kind === 'v4'
          ? new TonClient4({ endpoint: ep.jsonRpcUrl, timeout: 15_000 })
          : new TonClient({ endpoint: ep.jsonRpcUrl, ...(ep.apiKey ? { apiKey: ep.apiKey } : {}) })
      return client.open(wallet)
    }

    let seqno: number | null = null
    let lastErr: unknown
    for (const ep of endpoints) {
      try { seqno = await open(ep).getSeqno(); break } catch (err) { lastErr = err }
    }
    if (seqno === null) throw lastErr instanceof Error ? lastErr : new Error('TON delivery: could not read the wallet seqno on any endpoint')

    const transfer = buildTransfer(seqno)
    // Body cell hash — the identifier TON verification matches against the wallet's inbound message.
    const txHash = transfer.hash().toString('hex')
    if (journal) await journal({ txHash, nonce: seqno })

    let sent = false
    for (const ep of endpoints) {
      try { await open(ep).send(transfer); sent = true; break } catch (err) { lastErr = err }
    }
    if (!sent) logger.warn({ err: lastErr, txHash }, 'TON delivery send failed on every endpoint — outcome unknown, hash journaled for verification')
    return txHash
  } finally {
    seed.fill(0)
    if (privateKey) privateKey.fill(0)
  }
}

// ── SUI delivery ──────────────────────────────────────────────────────────────

/**
 * Run a SUI delivery op against the first RPC endpoint that succeeds, walking
 * getSuiRpcEndpoints(). A rate-limited / down primary (the Mysten public fullnode
 * 429s hard from shared cloud IPs) no longer blocks payouts — in practice the
 * throttled provider fails on the first read (getCoins / dry-run) before anything
 * is submitted, so failover just picks the next node. The order-level state
 * machine is the backstop against re-delivery once a digest is recorded.
 */
async function withSuiClientFailover<T>(
  fn: (client: import('@mysten/sui/client').SuiClient) => Promise<T>,
): Promise<T> {
  const { SuiClient } = await import('@mysten/sui/client')
  let lastErr: unknown
  for (const url of getSuiRpcEndpoints()) {
    try {
      return await fn(new SuiClient({ url }))
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('SUI delivery failed on all RPC endpoints')
}

/**
 * Sui: build + sign ONCE (read-only RPC, safe to fail over), journal the digest — fixed by the
 * signed bytes — then execute the identical bytes. Re-submitting identical signed bytes to another
 * node is idempotent (the tx executes at most once), so execution may fail over safely.
 */
async function executeSuiJournaled(
  signed: { bytes: string; signature: string },
  journal?: DeliveryJournal,
): Promise<string> {
  const { TransactionDataBuilder } = await import('@mysten/sui/transactions')
  const { fromBase64 } = await import('@mysten/sui/utils')
  const digest = TransactionDataBuilder.getDigestFromBytes(fromBase64(signed.bytes))
  if (journal) await journal({ txHash: digest })
  try {
    await withSuiClientFailover((client) => client.executeTransactionBlock({
      transactionBlock: signed.bytes,
      signature: signed.signature,
      requestType: 'WaitForLocalExecution',
      options: { showEffects: true },
    }))
  } catch (err) {
    logger.warn({ err, txHash: digest }, 'Sui delivery execute returned an error — outcome unknown, digest journaled for verification')
  }
  return digest
}

async function deliverSui(order: GasFeeOrder, _hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { Transaction } = await import('@mysten/sui/transactions')

  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSuiPrivateKeyForDelivery(seed)
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(privateKeySeed))

    const mistAmount = BigInt(Math.round(Number(order.gasAmountNative) * 1e9))

    const signed = await withSuiClientFailover(async (client) => {
      const tx = new Transaction()
      const [coin] = tx.splitCoins(tx.gas, [mistAmount])
      tx.transferObjects([coin], order.toAddress)
      return tx.sign({ client, signer: keypair })
    })
    return await executeSuiJournaled(signed, journal)
  } finally {
    seed.fill(0)
    if (privateKeySeed) privateKeySeed.fill(0)
  }
}

// SUI Coin<T> transfer (USDC etc.). Gathers the hot wallet's coin objects of this
// type (merging when the balance is fragmented), splits off the exact amount and
// transfers it — gas is paid from the wallet's native SUI coins as usual.
async function deliverSuiToken(order: GasFeeOrder, coinType: string, decimals: number, journal?: DeliveryJournal): Promise<string> {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { Transaction } = await import('@mysten/sui/transactions')

  // toFixed avoids float drift before scaling to base units (mirrors the Aptos path).
  const amount = BigInt(Math.round(Number(Number(order.gasAmountNative).toFixed(decimals)) * 10 ** decimals))
  if (amount <= 0n) throw new Error(`deliverSuiToken: non-positive amount for ${order.gasAmountNative}`)

  const seed = decryptGasSeed()
  let privateKeySeed: Buffer | null = null
  try {
    privateKeySeed = deriveSuiPrivateKeyForDelivery(seed)
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(privateKeySeed))
    const owner = keypair.getPublicKey().toSuiAddress()

    const signed = await withSuiClientFailover(async (client) => {
      // Collect coin objects of this type until they cover the amount (largest first
      // keeps the merge set small; paginate in case holdings are fragmented).
      const coins: Array<{ coinObjectId: string; balance: bigint }> = []
      let cursor: string | null | undefined
      do {
        const page = await client.getCoins({ owner, coinType, ...(cursor ? { cursor } : {}) })
        for (const c of page.data) coins.push({ coinObjectId: c.coinObjectId, balance: BigInt(c.balance) })
        cursor = page.hasNextPage ? page.nextCursor : null
      } while (cursor)
      coins.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))

      const picked: string[] = []
      let covered = 0n
      for (const c of coins) {
        picked.push(c.coinObjectId)
        covered += c.balance
        if (covered >= amount) break
      }
      if (covered < amount) {
        throw new Error(`deliverSuiToken: hot wallet holds ${covered} base units of ${coinType}, need ${amount}`)
      }

      const tx = new Transaction()
      const primary = tx.object(picked[0]!)
      if (picked.length > 1) tx.mergeCoins(primary, picked.slice(1).map((id) => tx.object(id)))
      const [out] = tx.splitCoins(primary, [amount])
      tx.transferObjects([out!], order.toAddress)
      return tx.sign({ client, signer: keypair })
    })
    return await executeSuiJournaled(signed, journal)
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

export async function deliverGas(order: GasFeeOrder, hdIndex = HOT_WALLET_INDEX, journal?: DeliveryJournal): Promise<string> {
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
      return deliverToken(order, tokenCfg.contractAddress, hdIndex, journal)
    }
  }

  // Pre-flight: confirm hot wallet has enough native balance before sending.
  await assertHotWalletSufficient(order)

  switch (order.chain) {
    case 'TRON':  return deliverTron(order, hdIndex)
    case 'BSC':   return deliverBsc(order, hdIndex, journal)
    case 'OPBNB': return deliverOpBnb(order, hdIndex, journal)
    case 'ETH':   return deliverEth(order, hdIndex, journal)
    case 'BASE':  return deliverBase(order, hdIndex, journal)
    case 'ARB':   return deliverArb(order, hdIndex, journal)
    case 'OP':    return deliverOp(order, hdIndex, journal)
    case 'MATIC': return deliverMatic(order, hdIndex, journal)
    case 'AVAX':  return deliverAvax(order, hdIndex, journal)
    case 'SOL':   return deliverSol(order, hdIndex, journal)
    case 'TON':   return deliverTon(order, hdIndex, journal)
    case 'SUI':   return deliverSui(order, hdIndex, journal)
    case 'APT':   return deliverAptosNative(order, journal)
    default: throw new Error(`deliverGas: unsupported chain ${order.chain}`)
  }
}

/**
 * Cancel a stuck EVM delivery: broadcast a 0-value self-transfer from the same hot wallet at the
 * SAME nonce with a much higher fee. Only one tx can ever use that nonce, so once either lands the
 * other is dead. If the original wins it simply lands (the order is then adopted as delivered).
 * Admin-triggered only; never called by automation.
 */
export async function cancelStuckEvmDelivery(order: Pick<GasFeeOrder, 'chain' | 'unconfirmedDeliveryTxHash' | 'deliveryNonce' | 'fromHotWallet'>): Promise<{ cancelTxHash: string; nonce: number }> {
  const m = EVM_TOKEN_CHAINS[order.chain]
  if (!m) throw new Error(`Cancel is only available for EVM chains (got ${order.chain})`)
  if (order.deliveryNonce === null || !order.fromHotWallet || !order.unconfirmedDeliveryTxHash) {
    throw new Error('This order has no journaled nonce / sender, so the stuck tx cannot be cancelled automatically.')
  }
  const sender = order.fromHotWallet
  const wallets = await db.gasHotWallet.findMany({ where: { chain: order.chain as never } })
  const hw = wallets.find((w) => w.address.toLowerCase() === sender.toLowerCase())
  if (!hw) throw new Error(`Hot wallet ${sender} not found for ${order.chain}`)

  const nonce = order.deliveryNonce
  const rpcUrl = await getWorkingRpcUrl(order.chain === 'ETH' ? 'ETHEREUM' : (order.chain as GasChainId), m.rpc)
  const seed = decryptGasSeed()
  try {
    const account = privateKeyToAccount(deriveEvmPrivateKeyHex(seed, hw.hdIndex) as `0x${string}`)
    if (account.address.toLowerCase() !== sender.toLowerCase()) throw new Error('Derived hot wallet does not match the order sender')
    return await withHotWalletLock(order.chain, async () => {
      const pub = createPublicClient({ chain: m.chain, transport: http(rpcUrl) })
      const wallet = createWalletClient({ chain: m.chain, transport: http(rpcUrl), account })
      const confirmed = await getTransactionCount(rpcUrl, order.chain, account.address, 'latest')
      if (confirmed > nonce) throw new Error('That nonce is already used on-chain — nothing to cancel.')
      const orig = await pub.getTransaction({ hash: order.unconfirmedDeliveryTxHash as `0x${string}` }).catch(() => null)
      // Cheapest cancel that still replaces the original: the node requires >=10% more on BOTH fee
      // fields, so use +20%, but never less than what the network needs right now to include it.
      const head = await pub.getBlock({ blockTag: 'latest' }).catch(() => null)
      const baseFee = head?.baseFeePerGas ?? 0n
      const est = await pub.estimateFeesPerGas({ chain: m.chain, type: 'eip1559' } as never).catch(() => null) as { maxPriorityFeePerGas?: bigint } | null
      let tip = est?.maxPriorityFeePerGas ?? 0n
      if (orig?.maxPriorityFeePerGas && orig.maxPriorityFeePerGas * 12n / 10n + 1n > tip) tip = orig.maxPriorityFeePerGas * 12n / 10n + 1n
      let maxFee = baseFee > 0n ? baseFee * 5n / 4n + tip : 0n
      if (orig?.maxFeePerGas && orig.maxFeePerGas * 12n / 10n + 1n > maxFee) maxFee = orig.maxFeePerGas * 12n / 10n + 1n
      if (tip > maxFee) tip = maxFee
      const base = { account, chain: m.chain, to: account.address, value: 0n, nonce, gas: 21_000n } as const
      const cancelTxHash = maxFee > 0n
        ? await wallet.sendTransaction({ ...base, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip })
        : await wallet.sendTransaction({ ...base, ...(orig?.gasPrice ? { gasPrice: orig.gasPrice * 3n / 2n } : {}) })
      return { cancelTxHash, nonce }
    })
  } finally {
    seed.fill(0)
  }
}
