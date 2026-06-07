import { logger } from './logger'

/**
 * Minimal JSON-RPC client for EVM chains. Used by the deposit reconciler to
 * verify on-chain transaction state independently of Moralis Streams.
 *
 * Intentionally tiny — we only need three calls:
 *   - eth_blockNumber
 *   - eth_getTransactionReceipt
 *   - eth_getTransactionByHash (for confirming the from/to/value when receipt
 *     doesn't carry value)
 *
 * No SDK dependency. All numeric fields come back as 0x-prefixed hex strings
 * and are decoded with `BigInt`.
 */

export class EvmRpcError extends Error {
  constructor(public chain: string, public method: string, public reason: string) {
    super(`evm_rpc ${chain}/${method}: ${reason}`)
    this.name = 'EvmRpcError'
  }
}

export interface EvmTxReceipt {
  /** '0x1' for success, '0x0' for revert. */
  status: '0x0' | '0x1'
  /** Block number the tx was mined in. */
  blockNumber: bigint
  from: string
  to: string | null
  transactionHash: string
}

export interface EvmTxLog {
  /** The contract address that emitted this log. */
  address: string
  topics: string[]
  data: string
  transactionHash: string
  logIndex: string
}

export interface EvmTxBasic {
  hash: string
  from: string
  to: string | null
  /** Native value in wei. */
  value: bigint
  blockNumber: bigint | null
  /** `null` when the tx is still in the mempool. */
  blockHash: string | null
}

async function rpcCall<T>(url: string, chain: string, method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new EvmRpcError(chain, method, `HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } }
    if (json.error) throw new EvmRpcError(chain, method, json.error.message ?? 'unknown_error')
    if (json.result === undefined) throw new EvmRpcError(chain, method, 'no_result')
    return json.result
  } catch (err) {
    if (err instanceof EvmRpcError) throw err
    throw new EvmRpcError(chain, method, err instanceof Error ? err.message : 'unknown_error')
  } finally {
    clearTimeout(timeout)
  }
}

export async function getBlockNumber(rpcUrl: string, chain: string): Promise<bigint> {
  const hex = await rpcCall<string>(rpcUrl, chain, 'eth_blockNumber', [])
  return BigInt(hex)
}

export async function getEvmGasPrice(rpcUrl: string, chain: string): Promise<bigint> {
  const hex = await rpcCall<string>(rpcUrl, chain, 'eth_gasPrice', [])
  return BigInt(hex)
}

/**
 * Fetch the transaction count (nonce) for an address. Use block='pending' to
 * include txs already in the mempool — essential for serialized sends from the
 * shared hot wallet so each broadcast gets a distinct, non-colliding nonce.
 */
export async function getTransactionCount(
  rpcUrl: string,
  chain: string,
  address: string,
  block: 'pending' | 'latest' = 'pending',
): Promise<number> {
  const hex = await rpcCall<string>(rpcUrl, chain, 'eth_getTransactionCount', [address, block])
  return Number(BigInt(hex))
}

export async function getTransactionReceipt(
  rpcUrl: string,
  chain: string,
  txHash: string,
): Promise<EvmTxReceipt | null> {
  const raw = await rpcCall<{
    status?: string
    blockNumber?: string
    from?: string
    to?: string | null
    transactionHash?: string
  } | null>(rpcUrl, chain, 'eth_getTransactionReceipt', [txHash])
  if (!raw) return null
  if (!raw.status || !raw.blockNumber || !raw.from || !raw.transactionHash) {
    logger.warn({ chain, txHash, raw }, 'eth_getTransactionReceipt missing required fields')
    return null
  }
  if (raw.status !== '0x0' && raw.status !== '0x1') {
    throw new EvmRpcError(chain, 'eth_getTransactionReceipt', `unexpected status ${raw.status}`)
  }
  return {
    status: raw.status,
    blockNumber: BigInt(raw.blockNumber),
    from: raw.from,
    to: raw.to ?? null,
    transactionHash: raw.transactionHash,
  }
}

export interface EvmReceiptWithLogs extends EvmTxReceipt {
  logs: EvmTxLog[]
}

export async function getTransactionReceiptWithLogs(
  rpcUrl: string,
  chain: string,
  txHash: string,
): Promise<EvmReceiptWithLogs | null> {
  const raw = await rpcCall<{
    status?: string
    blockNumber?: string
    from?: string
    to?: string | null
    transactionHash?: string
    logs?: Array<{
      address?: string
      topics?: string[]
      data?: string
      transactionHash?: string
      logIndex?: string
    }>
  } | null>(rpcUrl, chain, 'eth_getTransactionReceipt', [txHash])
  if (!raw) return null
  if (!raw.status || !raw.blockNumber || !raw.from || !raw.transactionHash) {
    logger.warn({ chain, txHash }, 'eth_getTransactionReceipt (with logs) missing required fields')
    return null
  }
  if (raw.status !== '0x0' && raw.status !== '0x1') {
    throw new EvmRpcError(chain, 'eth_getTransactionReceipt', `unexpected status ${raw.status}`)
  }
  const logs: EvmTxLog[] = (raw.logs ?? []).map((l) => ({
    address: (l.address ?? '').toLowerCase(),
    topics: l.topics ?? [],
    data: l.data ?? '0x',
    transactionHash: l.transactionHash ?? txHash,
    logIndex: l.logIndex ?? '0x0',
  }))
  return {
    status: raw.status,
    blockNumber: BigInt(raw.blockNumber),
    from: raw.from,
    to: raw.to ?? null,
    transactionHash: raw.transactionHash,
    logs,
  }
}

// keccak256("Transfer(address,address,uint256)")
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Parse all ERC20 Transfer events in a receipt's logs for a specific token contract.
 * Returns { from, to, value } for every Transfer log that matches.
 */
export function parseErc20Transfers(
  logs: EvmTxLog[],
  tokenContract: string,
): Array<{ from: string; to: string; value: bigint }> {
  const contractLower = tokenContract.toLowerCase()
  const results: Array<{ from: string; to: string; value: bigint }> = []
  for (const log of logs) {
    if (log.address !== contractLower) continue
    if (log.topics.length < 3) continue
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
    const from = '0x' + (log.topics[1] ?? '').slice(-40)
    const to = '0x' + (log.topics[2] ?? '').slice(-40)
    let value: bigint
    try {
      value = log.data === '0x' || log.data === '' ? 0n : BigInt(log.data)
    } catch {
      continue
    }
    results.push({ from, to, value })
  }
  return results
}

export async function getTransactionByHash(
  rpcUrl: string,
  chain: string,
  txHash: string,
): Promise<EvmTxBasic | null> {
  const raw = await rpcCall<{
    hash?: string
    from?: string
    to?: string | null
    value?: string
    blockNumber?: string | null
    blockHash?: string | null
  } | null>(rpcUrl, chain, 'eth_getTransactionByHash', [txHash])
  if (!raw || !raw.hash || !raw.from) return null
  return {
    hash: raw.hash,
    from: raw.from,
    to: raw.to ?? null,
    value: BigInt(raw.value ?? '0x0'),
    blockNumber: raw.blockNumber ? BigInt(raw.blockNumber) : null,
    blockHash: raw.blockHash ?? null,
  }
}
