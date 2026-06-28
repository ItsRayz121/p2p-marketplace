import { env } from './env'
import { logger } from './logger'

/**
 * Thin client over the Moralis Streams REST API.
 *
 * We use `fetch` directly rather than pulling in the @moralisweb3/* SDK —
 * the SDK is heavy and we only need three endpoints. Auth is via the
 * `x-api-key` header.
 *
 * Rate limiting is enforced at the *worker* level (BullMQ limiter) rather
 * than inside this client, which keeps retry semantics inside the queue
 * where they belong.
 */

export class MoralisApiError extends Error {
  constructor(public status: number, public body: string, message?: string) {
    super(message ?? `Moralis API ${status}: ${body.slice(0, 200)}`)
    this.name = 'MoralisApiError'
  }

  /** Errors we should give up on instead of retrying. */
  get isFatal(): boolean {
    // 401/403 = bad api key — won't fix with retry.
    // 404 = stream id wrong — won't fix with retry.
    // 422 / 400 = malformed input — won't fix with retry.
    return this.status === 400 || this.status === 401 || this.status === 403 || this.status === 404 || this.status === 422
  }
}

interface RequestInitWithTimeout extends RequestInit {
  timeoutMs?: number
}

async function moralisFetch(path: string, init: RequestInitWithTimeout = {}): Promise<Response> {
  if (!env.MORALIS_API_KEY) {
    throw new MoralisApiError(503, 'no_api_key', 'MORALIS_API_KEY not configured')
  }
  const url = env.MORALIS_API_BASE_URL.replace(/\/+$/, '') + path
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000)
  try {
    return await fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': env.MORALIS_API_KEY,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Add a single address to the watch list of a Moralis Stream.
 *
 * Moralis returns 200 on success AND on "already in list" (idempotent on
 * their side as of the V2 API). Both cases are treated as success here.
 *
 * Throws MoralisApiError on non-2xx. The error's `isFatal` getter tells the
 * caller whether to retry.
 */
export async function addAddressToStream(streamId: string, address: string): Promise<void> {
  const res = await moralisFetch(`/streams/evm/${encodeURIComponent(streamId)}/address`, {
    method: 'POST',
    body: JSON.stringify({ address: [address] }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.warn({ streamId, status: res.status, body: body.slice(0, 200) }, 'Moralis add-address non-2xx')
    throw new MoralisApiError(res.status, body)
  }
}

/**
 * Fetch the metadata for a Stream — used by startup validation and by the
 * admin status endpoint. Returns null if the stream id is wrong (404).
 */
export async function getStreamMetadata(streamId: string): Promise<unknown | null> {
  const res = await moralisFetch(`/streams/evm/${encodeURIComponent(streamId)}`, {
    method: 'GET',
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new MoralisApiError(res.status, body)
  }
  return res.json().catch(() => null)
}

// ── Moralis Web3 Data API (separate base URL from Streams) ───────────────────

const WEB3_BASE = 'https://deep-index.moralis.io/api/v2.2'

// EVM chain hex IDs recognised by Moralis Web3 Data API
const CHAIN_HEX: Record<string, string> = {
  BSC:  '0x38',
  ETH:  '0x1',
  MATIC:'0x89',
  ARB:  '0xa4b1',
  OP:   '0xa',
  BASE: '0x2105',
  AVAX: '0xa86a',
}

export interface MoralisTokenBalance {
  symbol: string
  name: string
  rawBalance: string  // raw integer string from chain
  decimals: number
  tokenAddress: string
  balanceFormatted: number  // rawBalance / 10^decimals
}

/**
 * Fetch all ERC-20 token balances for a hot wallet address.
 * Uses the Moralis Web3 Data API (deep-index), not the Streams API.
 * Returns [] if chain is not EVM or API key is missing.
 */
export async function getWalletTokenBalances(chain: string, address: string): Promise<MoralisTokenBalance[]> {
  const hexChain = CHAIN_HEX[chain.toUpperCase()]
  if (!hexChain || !env.MORALIS_API_KEY) return []

  try {
    const url = `${WEB3_BASE}/${encodeURIComponent(address)}/erc20?chain=${hexChain}`
    const res = await fetch(url, {
      headers: { 'x-api-key': env.MORALIS_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return []

    const data = await res.json() as Array<{
      symbol: string; name: string; balance: string; decimals: string | number; token_address: string
    }>

    return data.map((t) => {
      const decimals = Number(t.decimals)
      const rawBalance = t.balance
      const balanceFormatted = parseFloat(rawBalance) / Math.pow(10, decimals)
      return { symbol: t.symbol, name: t.name, rawBalance, decimals, tokenAddress: t.token_address, balanceFormatted }
    })
  } catch {
    return []
  }
}

export interface MoralisErc20Transfer {
  txHash: string
  fromAddress: string
  toAddress: string
  rawValue: string        // raw integer string from chain
  decimals: number
  blockNumber: number
  blockTimestampMs: number | null
}

/**
 * Fetch recent ERC-20 transfers of a single token to/from a wallet via the
 * Moralis Web3 Data API (deep-index), newest first.
 *
 * This is the gas poller's LAST-RESORT detection fallback: it is only ever called
 * when Etherscan AND every getLogs RPC endpoint have failed, so in steady state it
 * runs essentially never and costs ~zero CU. It is never the primary path.
 *
 * Returns `null` on any failure (unconfigured key, non-EVM chain, HTTP error,
 * timeout) so the caller can fall through to the balance watchdog; returns the
 * (possibly empty) transfer list on success.
 */
export async function getWalletErc20Transfers(opts: {
  chain: string
  address: string
  contractAddress: string
  fromBlock?: number
  limit?: number
}): Promise<MoralisErc20Transfer[] | null> {
  const hexChain = CHAIN_HEX[opts.chain.toUpperCase()]
  if (!hexChain || !env.MORALIS_API_KEY) return null

  const url = new URL(`${WEB3_BASE}/${encodeURIComponent(opts.address)}/erc20/transfers`)
  url.searchParams.set('chain', hexChain)
  url.searchParams.append('contract_addresses[]', opts.contractAddress)
  url.searchParams.set('order', 'DESC')
  url.searchParams.set('limit', String(opts.limit ?? 100))
  if (opts.fromBlock != null) url.searchParams.set('from_block', String(opts.fromBlock))

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': env.MORALIS_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status, chain: opts.chain }, 'Moralis erc20/transfers non-2xx')
      return null
    }
    const json = (await res.json()) as {
      result?: Array<{
        transaction_hash?: string; from_address?: string; to_address?: string
        value?: string; token_decimals?: string | number
        block_number?: string | number; block_timestamp?: string
      }>
    }
    const rows = json.result ?? []
    return rows.flatMap((r) => {
      if (!r.transaction_hash || !r.value) return []
      const decimals = Number(r.token_decimals)
      const blockNumber = Number(r.block_number)
      if (!Number.isFinite(decimals) || !Number.isFinite(blockNumber)) return []
      const tsMs = r.block_timestamp ? Date.parse(r.block_timestamp) : NaN
      return [{
        txHash: r.transaction_hash,
        fromAddress: r.from_address ?? '',
        toAddress: r.to_address ?? '',
        rawValue: r.value,
        decimals,
        blockNumber,
        blockTimestampMs: Number.isFinite(tsMs) ? tsMs : null,
      }]
    })
  } catch (err) {
    logger.warn({ err, chain: opts.chain }, 'Moralis erc20/transfers fetch errored')
    return null
  }
}
