import type { Chain } from 'viem'
import { createPublicClient, http, formatEther } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { redis } from '../redis'
import { env } from '../env'
import { logger } from '../logger'
import type { GasChainId } from './gas.chains'
import { getSolanaBalance, checkSolanaRpc } from './solanaWalletService'
import { getTonBalance, checkTonRpc } from './tonWalletService'
import { getSuiBalance, checkSuiRpc } from './suiWalletService'

// ── RPC health result ─────────────────────────────────────────────────────────

export interface RpcHealthResult {
  reachable: boolean
  blockNumber?: number
  latencyMs: number
  error?: string
  /** true when block number hasn't advanced in 5+ min (stale node) */
  isStale?: boolean
}

// ── Native → USD price ────────────────────────────────────────────────────────

// Polygon renamed its native token from MATIC to POL in September 2024.
// rate:POL and rate:MATIC are both written by the rate updater every cycle.
// The lookup tries the primary symbol first; if price is 0 it falls back to
// the alias so the pipeline is resilient to any single source being stale.
const CHAIN_PRICE_SYMBOL: Record<GasChainId, string> = {
  TRON:     'TRX',
  BSC:      'BNB',
  ETHEREUM: 'ETH',
  BASE:     'ETH',
  ARB:      'ETH',
  OP:       'ETH',
  MATIC:    'POL',   // display symbol = POL; rate:POL written by rate updater
  AVAX:     'AVAX',
  SOL:      'SOL',
  TON:      'TON',
  SUI:      'SUI',
}

// POL ↔ MATIC legacy compatibility: if either Redis key is missing, try the other.
const PRICE_SYMBOL_ALIASES: Record<string, string> = {
  POL:   'MATIC',
  MATIC: 'POL',
}

// CoinGecko IDs used for the live-fetch fallback when all Redis paths fail.
const CHAIN_GECKO_IDS: Partial<Record<GasChainId, string>> = {
  TRON:     'tron',
  BSC:      'binancecoin',
  ETHEREUM: 'ethereum',
  BASE:     'ethereum',
  ARB:      'ethereum',
  OP:       'ethereum',
  MATIC:    'matic-network',
  AVAX:     'avalanche-2',
  SOL:      'solana',
  TON:      'the-open-network',
  SUI:      'sui',
}

// CoinPaprika IDs used as a second live-fetch fallback (avoids CoinGecko rate limits).
// IMPORTANT: CoinPaprika uses different slugs from CoinGecko — 'matic-polygon', NOT 'matic-network'.
const CHAIN_PAPRIKA_IDS: Partial<Record<GasChainId, string>> = {
  TRON:     'trx-tron',
  BSC:      'bnb-binance-coin',
  ETHEREUM: 'eth-ethereum',
  BASE:     'eth-ethereum',
  ARB:      'eth-ethereum',
  OP:       'eth-ethereum',
  MATIC:    'matic-polygon',
  AVAX:     'avax-avalanche',
  SOL:      'sol-solana',
  TON:      'ton-the-open-network',
  SUI:      'sui-sui',
}

interface CoinEntry { pkrRate: number; usdPrice: number }

async function readCoinEntry(symbol: string): Promise<CoinEntry> {
  const raw = await redis.get(`rate:${symbol}`)
  if (!raw) return { pkrRate: 0, usdPrice: 0 }
  const parsed = JSON.parse(raw) as { rate?: number; usdPrice?: number }
  return { pkrRate: parsed.rate ?? 0, usdPrice: parsed.usdPrice ?? 0 }
}

export async function getNativeUsdPrice(chain: GasChainId): Promise<number> {
  const symbol = CHAIN_PRICE_SYMBOL[chain]

  let entry = await readCoinEntry(symbol)

  // Fallback: if primary symbol has no data, try the alias (POL↔MATIC)
  if (entry.usdPrice === 0 && entry.pkrRate === 0) {
    const alias = PRICE_SYMBOL_ALIASES[symbol]
    if (alias) {
      const aliasEntry = await readCoinEntry(alias)
      if (aliasEntry.usdPrice > 0 || aliasEntry.pkrRate > 0) {
        entry = aliasEntry
        logger.debug({ chain, primarySymbol: symbol, fallbackAlias: alias },
          '[gas-price] alias fallback resolved price')
      }
    }
  }

  // Path 1: usdPrice is stored directly in the Redis JSON — most reliable, no
  // dependency on rate:USD_PKR being present.
  if (entry.usdPrice > 0) {
    logger.debug({ chain, symbol, usdPrice: entry.usdPrice }, '[gas-price] from redis usdPrice field')
    return entry.usdPrice
  }

  // Path 2: convert PKR rate using rate:USD_PKR
  if (entry.pkrRate > 0) {
    const usdPkrStr = await redis.get('rate:USD_PKR')
    const usdPkr = usdPkrStr ? parseFloat(usdPkrStr) : 0
    if (usdPkr > 0) {
      const usdPrice = entry.pkrRate / usdPkr
      logger.debug({ chain, symbol, usdPrice, pkrRate: entry.pkrRate, usdPkr }, '[gas-price] from pkr conversion')
      return usdPrice
    }
  }

  // Path 3: live CoinGecko fetch — last resort when Redis has nothing.
  // Writes back to Redis (30 min TTL) so subsequent calls hit the cache.
  const geckoId = CHAIN_GECKO_IDS[chain]
  if (geckoId) {
    try {
      const isPro = !!env.COINGECKO_API_KEY
      const base = isPro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'
      const headers: Record<string, string> = isPro ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY! } : {}
      const res = await fetch(`${base}/simple/price?ids=${geckoId}&vs_currencies=usd`, {
        headers,
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd?: number }>
        const price = data[geckoId]?.usd
        if (price && price > 0) {
          const usdPkrStr = await redis.get('rate:USD_PKR')
          const usdPkr = usdPkrStr ? parseFloat(usdPkrStr) : 278.5
          const pkrRate = price * usdPkr
          const now = new Date().toISOString()
          const val = JSON.stringify({ rate: pkrRate, usdPrice: price, updatedAt: now, source: 'gas-balance-live' })
          await redis.set(`rate:${symbol}`, val, 'EX', 1800)
          const alias = PRICE_SYMBOL_ALIASES[symbol]
          if (alias) await redis.set(`rate:${alias}`, val, 'EX', 1800)
          logger.info({ chain, symbol, geckoId, usdPrice: price, pkrRate, redisKey: `rate:${symbol}` },
            '[gas-price] live-fetched from CoinGecko and cached in Redis')
          return price
        }
      }
    } catch (err) {
      logger.warn({ chain, symbol, geckoId, err: err instanceof Error ? err.message : String(err) },
        '[gas-price] live CoinGecko fetch failed')
    }
  }

  // Path 3b: CoinPaprika — free, no key required, avoids CoinGecko rate limits.
  const paprikaId = CHAIN_PAPRIKA_IDS[chain]
  if (paprikaId) {
    try {
      const res = await fetch(`https://api.coinpaprika.com/v1/tickers/${paprikaId}`, {
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = (await res.json()) as { quotes?: { USD?: { price?: number } } }
        const price = data.quotes?.USD?.price
        if (price && price > 0) {
          const usdPkrStr = await redis.get('rate:USD_PKR')
          const usdPkr = usdPkrStr ? parseFloat(usdPkrStr) : 278.5
          const pkrRate = price * usdPkr
          const now = new Date().toISOString()
          const val = JSON.stringify({ rate: pkrRate, usdPrice: price, updatedAt: now, source: 'gas-balance-coinpaprika' })
          await redis.set(`rate:${symbol}`, val, 'EX', 1800)
          const alias = PRICE_SYMBOL_ALIASES[symbol]
          if (alias) await redis.set(`rate:${alias}`, val, 'EX', 1800)
          logger.info({ chain, symbol, paprikaId, usdPrice: price, redisKey: `rate:${symbol}` },
            '[gas-price] live-fetched from CoinPaprika and cached in Redis')
          return price
        }
      }
    } catch (err) {
      logger.warn({ chain, symbol, paprikaId, err: err instanceof Error ? err.message : String(err) },
        '[gas-price] CoinPaprika fetch failed')
    }
  }

  logger.warn({ chain, symbol }, '[gas-price] all price paths failed — returning 0')
  return 0
}

// ── TRON balance ──────────────────────────────────────────────────────────────

// Friendly error surfaced to the admin UI instead of a raw "HTTP 429".
class TronRateLimitedError extends Error {
  constructor() { super('TRON provider temporarily rate limited. Retrying automatically.') }
}

// Must exceed the ~60s balance poll interval, otherwise every poll misses the
// cache and still hits TronGrid. 90s lets every other poll serve from cache.
const TRON_BALANCE_CACHE_TTL = 90
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Primary: TronGrid full node. */
async function fetchTronGridBalance(address: string): Promise<number> {
  const url = `${env.TRON_FULLNODE_URL}/v1/accounts/${encodeURIComponent(address)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY

  // Up to 3 attempts with exponential backoff on 429 / 5xx.
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ balance?: number }> }
      return (data.data?.[0]?.balance ?? 0) / 1_000_000 // SUN → TRX
    }
    lastStatus = res.status
    if (res.status !== 429 && res.status < 500) break // non-retryable
    await sleep(300 * Math.pow(2, attempt)) // 300ms, 600ms, 1200ms
  }
  if (lastStatus === 429) throw new TronRateLimitedError()
  throw new Error(`TronGrid accounts API error: HTTP ${lastStatus}`)
}

/** Secondary fallback: Tronscan public account API (no key required). */
async function fetchTronscanBalance(address: string): Promise<number> {
  const url = `https://apilist.tronscanapi.com/api/account?address=${encodeURIComponent(address)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Tronscan account API error: HTTP ${res.status}`)
  const data = (await res.json()) as { balance?: number }
  return (data.balance ?? 0) / 1_000_000 // SUN → TRX
}

async function getTronBalanceTRX(address: string): Promise<number> {
  const cacheKey = `gasbal:tron:${address}`
  try {
    const cached = await redis.get(cacheKey)
    if (cached !== null) return parseFloat(cached)
  } catch { /* redis miss is non-fatal */ }

  let balance: number
  try {
    balance = await fetchTronGridBalance(address)
  } catch (primaryErr) {
    // On rate-limit / failure, try the secondary provider before giving up.
    try {
      balance = await fetchTronscanBalance(address)
      logger.warn({ address }, '[gas-balance] TronGrid failed; served TRON balance from Tronscan fallback')
    } catch {
      throw primaryErr // surface the (friendly) primary error
    }
  }

  try { await redis.set(cacheKey, String(balance), 'EX', TRON_BALANCE_CACHE_TTL) } catch { /* non-fatal */ }
  return balance
}

// ── EVM native balance via viem ───────────────────────────────────────────────

async function getEvmNativeBalance(
  viemChain: Chain,
  rpcUrl: string,
  address: string,
): Promise<number> {
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl, { timeout: 10_000 }) })
  const balanceWei = await client.getBalance({ address: address as `0x${string}` })
  return parseFloat(formatEther(balanceWei))
}

// ── RPC health checks ─────────────────────────────────────────────────────────

async function checkEvmRpc(viemChain: Chain, rpcUrl: string): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl, { timeout: 8_000 }) })
    const blockNumber = await client.getBlockNumber()
    const latencyMs = Date.now() - start

    const cacheKey = `gas_rpc_block:${viemChain.id}`
    const prevEntry = await redis.get(cacheKey)
    let isStale = false
    if (prevEntry) {
      const { block: prevBlock, ts } = JSON.parse(prevEntry) as { block: number; ts: number }
      if (Date.now() - ts > 300_000 && Number(blockNumber) <= prevBlock) isStale = true
    }
    await redis.set(cacheKey, JSON.stringify({ block: Number(blockNumber), ts: Date.now() }), 'EX', 600)

    return { reachable: true, blockNumber: Number(blockNumber), latencyMs, isStale }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

async function checkTronRpc(rpcUrl: string): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const res = await fetch(`${rpcUrl}/wallet/getnowblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
    const data = await res.json() as { block_header?: { raw_data?: { number?: number } } }
    const blockNumber = data?.block_header?.raw_data?.number
    if (typeof blockNumber !== 'number') {
      return { reachable: false, latencyMs, error: 'Invalid response: missing block_header.raw_data.number' }
    }
    const cacheKey = 'gas_rpc_block:tron'
    const prevEntry = await redis.get(cacheKey)
    let isStale = false
    if (prevEntry) {
      const { block: prevBlock, ts } = JSON.parse(prevEntry) as { block: number; ts: number }
      if (Date.now() - ts > 300_000 && blockNumber <= prevBlock) isStale = true
    }
    await redis.set(cacheKey, JSON.stringify({ block: blockNumber, ts: Date.now() }), 'EX', 600)
    return { reachable: true, blockNumber, latencyMs, isStale }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function testRpcHealth(chain: GasChainId): Promise<RpcHealthResult> {
  switch (chain) {
    case 'TRON':     return checkTronRpc(env.TRON_FULLNODE_URL)
    case 'BSC':      return checkEvmRpc(bsc,       env.BSC_RPC_URL)
    case 'ETHEREUM': return checkEvmRpc(mainnet,   env.ETHEREUM_RPC_URL)
    case 'BASE':     return checkEvmRpc(base,      env.BASE_RPC_URL)
    case 'ARB':      return checkEvmRpc(arbitrum,  env.ARBITRUM_RPC_URL)
    case 'OP':       return checkEvmRpc(optimism,  env.OPTIMISM_RPC_URL)
    case 'MATIC':    return checkEvmRpc(polygon,   env.POLYGON_RPC_URL)
    case 'AVAX':     return checkEvmRpc(avalanche, env.AVALANCHE_RPC_URL)
    case 'SOL':      return checkSolanaRpc()
    case 'TON':      return checkTonRpc()
    case 'SUI':      return checkSuiRpc()
    default: return { reachable: false, latencyMs: 0, error: `Unsupported chain: ${chain}` }
  }
}

// ── Public balance dispatch ───────────────────────────────────────────────────

export async function getHotWalletBalance(chain: GasChainId, address: string): Promise<number> {
  switch (chain) {
    case 'TRON':     return getTronBalanceTRX(address)
    case 'BSC':      return getEvmNativeBalance(bsc,       env.BSC_RPC_URL,       address)
    case 'ETHEREUM': return getEvmNativeBalance(mainnet,   env.ETHEREUM_RPC_URL,  address)
    case 'BASE':     return getEvmNativeBalance(base,      env.BASE_RPC_URL,      address)
    case 'ARB':      return getEvmNativeBalance(arbitrum,  env.ARBITRUM_RPC_URL,  address)
    case 'OP':       return getEvmNativeBalance(optimism,  env.OPTIMISM_RPC_URL,  address)
    case 'MATIC':    return getEvmNativeBalance(polygon,   env.POLYGON_RPC_URL,   address)
    case 'AVAX':     return getEvmNativeBalance(avalanche, env.AVALANCHE_RPC_URL, address)
    case 'SOL':      return getSolanaBalance(address)
    case 'TON':      return getTonBalance(address)
    case 'SUI':      return getSuiBalance(address)
    default: throw new Error(`getHotWalletBalance: unsupported chain ${chain}`)
  }
}
