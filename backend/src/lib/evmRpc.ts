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
