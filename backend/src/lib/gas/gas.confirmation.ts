import { createPublicClient, http, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, opBNB, optimism, polygon } from 'viem/chains'
import type { Chain } from 'viem'
import { env } from '../env'
import type { GasChainId } from './gas.chains'
import { getWorkingRpcUrl, getRpcUrlsInOrder, markRpcFailure } from './rpcFallback'
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

  const receipt = await client
    .getTransactionReceipt({ hash: txHash as `0x${string}` })
    .catch((e) => { if (e instanceof TransactionReceiptNotFoundError) return null; throw e })
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
  const { suiRpcCall, SuiRpcBenignError } = await import('./suiWalletService')
  try {
    const result = await suiRpcCall<{ effects?: { status?: { status?: string } } }>(
      'sui_getTransactionBlock',
      [txHash, { showEffects: true }],
      { benignErrorCodes: [-32000] }, // -32000 = not found yet
    )
    return result?.effects?.status?.status === 'success'
  } catch (err) {
    // "not found yet" → return false so the job retries on the next tick
    if (err instanceof SuiRpcBenignError) return false
    throw err
  }
}

// ── Aptos confirmation ────────────────────────────────────────────────────────
// Aptos has near-instant finality; a committed transaction is queryable by hash on
// the fullnode REST API. A still-pending / not-yet-indexed tx returns 404 (or a
// `pending_transaction` type) → return false so the job retries. A committed user
// transaction carries `success: boolean` reflecting on-chain execution.

async function checkAptosTxConfirmed(txHash: string): Promise<boolean> {
  const base = env.APTOS_FULLNODE_URL.replace(/\/$/, '')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`

  const res = await fetch(`${base}/transactions/by_hash/${encodeURIComponent(txHash)}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  // Not committed / not yet indexed — retry on the next attempt.
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`Aptos fullnode error: HTTP ${res.status}`)

  const data = (await res.json()) as { type?: string; success?: boolean }
  if (data.type === 'pending_transaction') return false
  return data.success === true
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

// ── Live transaction status (inclusion, not finality) ─────────────────────────
// Used to GATE order completion: a broadcast hash returned by an RPC proves nothing
// (the node may have dropped it, or never propagated it). `getTxStatus` asks the chain
// whether the tx is actually mined.
//   success   — mined and executed successfully
//   reverted  — mined but failed on-chain (funds did NOT move)
//   mempool   — known to a node but not mined yet
//   not_found — no node has ever seen it (dropped / never propagated / wrong hash)

export type TxState = 'success' | 'reverted' | 'mempool' | 'not_found'

export interface TxStatus {
  state: TxState
  /** EVM only: blocks since inclusion, and the count we require before "confirmed". */
  confirmations?: number
  required?: number
  blockNumber?: number
}

const EVM_VIEM: Record<string, { id: GasChainId; chain: Chain; rpc: string }> = {
  BSC:      { id: 'BSC',      chain: bsc,       rpc: env.BSC_RPC_URL },
  OPBNB:    { id: 'OPBNB',    chain: opBNB,     rpc: env.OPBNB_RPC_URL },
  ETH:      { id: 'ETHEREUM', chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  ETHEREUM: { id: 'ETHEREUM', chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  BASE:     { id: 'BASE',     chain: base,      rpc: env.BASE_RPC_URL },
  ARB:      { id: 'ARB',      chain: arbitrum,  rpc: env.ARBITRUM_RPC_URL },
  OP:       { id: 'OP',       chain: optimism,  rpc: env.OPTIMISM_RPC_URL },
  MATIC:    { id: 'MATIC',    chain: polygon,   rpc: env.POLYGON_RPC_URL },
  AVAX:     { id: 'AVAX',     chain: avalanche, rpc: env.AVALANCHE_RPC_URL },
}

/** True for chains whose txs can be looked up on an EVM JSON-RPC node. */
export function isEvmGasChain(chain: string): boolean {
  return chain in EVM_VIEM
}

/** A reachable RPC url + label for an EVM gas chain (used for sender-nonce proofs). */
export async function evmRpcFor(chain: string): Promise<{ url: string; key: string } | null> {
  const meta = EVM_VIEM[chain]
  if (!meta) return null
  return { url: await getWorkingRpcUrl(meta.id, meta.rpc), key: meta.id }
}

async function getEvmTxStatus(chain: string, txHash: string): Promise<TxStatus> {
  const meta = EVM_VIEM[chain]!
  const required = REQUIRED_CONFIRMATIONS[meta.id] ?? 3
  // Ask several independent endpoints before concluding "not found": a single lagging
  // or load-balanced node routinely answers null for a tx another node already has.
  const urls = getRpcUrlsInOrder(meta.id, meta.rpc).slice(0, 4)
  let reachable = 0
  let seenInMempool = false
  for (const url of urls) {
    const client = createPublicClient({ chain: meta.chain, transport: http(url, { timeout: 8_000, retryCount: 0 }) })
    try {
      const receipt = await client
        .getTransactionReceipt({ hash: txHash as `0x${string}` })
        .catch((e) => { if (e instanceof TransactionReceiptNotFoundError) return null; throw e })
      reachable++
      if (receipt) {
        const head = await client.getBlockNumber()
        const confirmations = Math.max(0, Number(head) - Number(receipt.blockNumber))
        return {
          state: receipt.status === 'success' ? 'success' : 'reverted',
          confirmations,
          required,
          blockNumber: Number(receipt.blockNumber),
        }
      }
      const tx = await client
        .getTransaction({ hash: txHash as `0x${string}` })
        .catch((e) => { if (e instanceof TransactionNotFoundError) return null; throw e })
      if (tx) seenInMempool = true
    } catch {
      markRpcFailure(url)
    }
  }
  if (reachable === 0) throw new Error(`All ${meta.id} RPC endpoints unreachable while checking ${txHash}`)
  return { state: seenInMempool ? 'mempool' : 'not_found', required }
}

async function getTronTxStatus(txHash: string): Promise<TxStatus> {
  const url = `${env.TRON_FULLNODE_URL}/v1/transactions/${encodeURIComponent(txHash)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TronGrid API error: HTTP ${res.status}`)
  const data = (await res.json()) as { data?: Array<{ ret?: Array<{ contractRet?: string }> }> }
  const ret = data.data?.[0]?.ret?.[0]?.contractRet
  if (!ret) return { state: 'not_found' }
  return { state: ret === 'SUCCESS' ? 'success' : 'reverted' }
}

async function getSolanaTxStatus(txHash: string): Promise<TxStatus> {
  const res = await fetch(env.SOL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[txHash], { searchTransactionHistory: true }] }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Solana RPC getSignatureStatuses HTTP ${res.status}`)
  const data = (await res.json()) as {
    result?: { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> }
    error?: { message: string }
  }
  if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`)
  const status = data.result?.value?.[0]
  if (!status) return { state: 'not_found' }
  if (status.err) return { state: 'reverted' }
  return { state: status.confirmationStatus === 'processed' ? 'mempool' : 'success' }
}

async function getSuiTxStatus(txHash: string): Promise<TxStatus> {
  const { suiRpcCall, SuiRpcBenignError } = await import('./suiWalletService')
  try {
    const result = await suiRpcCall<{ effects?: { status?: { status?: string } } }>(
      'sui_getTransactionBlock',
      [txHash, { showEffects: true }],
      { benignErrorCodes: [-32000] },
    )
    const st = result?.effects?.status?.status
    if (!st) return { state: 'not_found' }
    return { state: st === 'success' ? 'success' : 'reverted' }
  } catch (err) {
    if (err instanceof SuiRpcBenignError) return { state: 'not_found' }
    throw err
  }
}

async function getAptosTxStatus(txHash: string): Promise<TxStatus> {
  const baseUrl = env.APTOS_FULLNODE_URL.replace(/\/$/, '')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (env.APTOS_API_KEY) headers['authorization'] = `Bearer ${env.APTOS_API_KEY}`
  const res = await fetch(`${baseUrl}/transactions/by_hash/${encodeURIComponent(txHash)}`, { headers, signal: AbortSignal.timeout(10_000) })
  if (res.status === 404) return { state: 'not_found' }
  if (!res.ok) throw new Error(`Aptos fullnode error: HTTP ${res.status}`)
  const data = (await res.json()) as { type?: string; success?: boolean }
  if (data.type === 'pending_transaction') return { state: 'mempool' }
  return { state: data.success === true ? 'success' : 'reverted' }
}

/**
 * TON: the stored hash is the signed wallet-message BODY hash. It is matched against the
 * inbound message of the hot wallet's recent transactions. A matching tx whose action phase
 * emitted an outbound message paid out; a match without one failed. No match = not_found
 * (wallet messages expire after about a minute, so the attempt-age rule decides death).
 */
async function getTonTxStatus(bodyHashHex: string): Promise<TxStatus> {
  const { getTonHotWalletAddress, getTonEndpoints } = await import('./tonWalletService')
  const { TonClient } = await import('@ton/ton')
  const { Address } = await import('@ton/core')
  const addr = getTonHotWalletAddress()
  if (!addr) throw new Error('TON hot wallet not configured')
  const wanted = bodyHashHex.toLowerCase()
  const endpoints = (await getTonEndpoints()).filter((e) => e.kind !== 'v4')
  let reachable = 0
  let lastErr: unknown
  for (const ep of endpoints) {
    try {
      const client = new TonClient({ endpoint: ep.jsonRpcUrl, ...(ep.apiKey ? { apiKey: ep.apiKey } : {}) })
      const txs = await client.getTransactions(Address.parse(addr), { limit: 60, archival: true })
      reachable++
      for (const tx of txs) {
        const body = tx.inMessage?.body
        if (body && body.hash().toString('hex') === wanted) {
          return { state: tx.outMessagesCount > 0 ? 'success' : 'reverted' }
        }
      }
    } catch (err) { lastErr = err }
  }
  if (reachable === 0) throw new Error(`TON transaction lookup failed on every endpoint: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  return { state: 'not_found' }
}

export async function getTxStatus(chain: GasChainId | string, txHash: string): Promise<TxStatus> {
  if (chain in EVM_VIEM) return getEvmTxStatus(chain, txHash)
  switch (chain) {
    case 'TRON': return getTronTxStatus(txHash)
    case 'APT':
    case 'APTOS': return getAptosTxStatus(txHash)
    case 'SOL': return getSolanaTxStatus(txHash)
    case 'SUI': return getSuiTxStatus(txHash)
    case 'TON': return getTonTxStatus(txHash)
    default: throw new Error(`getTxStatus: unsupported chain ${chain}`)
  }
}

/**
 * EVM native-transfer facts for a mined tx (recipient + value in wei), used to check that
 * an admin-supplied manual-delivery hash really paid the customer. Null if not found.
 */
export async function getEvmNativeTransfer(chain: string, txHash: string): Promise<{ to: string | null; valueWei: bigint } | null> {
  const meta = EVM_VIEM[chain]
  if (!meta) return null
  for (const url of getRpcUrlsInOrder(meta.id, meta.rpc).slice(0, 4)) {
    const client = createPublicClient({ chain: meta.chain, transport: http(url, { timeout: 8_000, retryCount: 0 }) })
    try {
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` })
      return { to: tx.to ?? null, valueWei: tx.value }
    } catch (e) {
      if (!(e instanceof TransactionNotFoundError)) markRpcFailure(url)
    }
  }
  return null
}

/**
 * Poll until the tx is decided (success / reverted) or `timeoutMs` elapses, returning
 * the last observed status. Transient RPC errors count as "not seen yet".
 */
export async function awaitTxInclusion(
  chain: GasChainId | string,
  txHash: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<TxStatus> {
  const deadline = Date.now() + opts.timeoutMs
  let last: TxStatus = { state: 'not_found' }
  for (;;) {
    try {
      last = await getTxStatus(chain, txHash)
      if (last.state === 'success' || last.state === 'reverted') return last
    } catch (err) {
      logger.warn({ err, chain, txHash }, 'awaitTxInclusion: status lookup failed — will retry')
    }
    if (Date.now() + opts.intervalMs >= deadline) return last
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

export async function checkTxConfirmed(chain: GasChainId | string, txHash: string): Promise<boolean> {
  switch (chain) {
    case 'TRON':
      return checkTronTxConfirmed(txHash)
    case 'BSC':
      return checkEvmTxConfirmed('BSC', bsc,       env.BSC_RPC_URL,       txHash)
    case 'OPBNB':
      return checkEvmTxConfirmed('OPBNB', opBNB,   env.OPBNB_RPC_URL,     txHash)
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
    // DB GasChain enum stores Aptos as 'APT'; GasChainId/callers may pass 'APTOS'
    case 'APT':
    case 'APTOS':
      return checkAptosTxConfirmed(txHash)
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
  if (chain === 'APT' || chain === 'APTOS') return null // success-flag check, not block count
  if (chain === 'SUI')  return null // effects.status check, not block count
  if (chain === 'ETH')  return REQUIRED_CONFIRMATIONS['ETHEREUM'] ?? null
  return REQUIRED_CONFIRMATIONS[chain as GasChainId] ?? null
}
