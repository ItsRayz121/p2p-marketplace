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

// CoinGecko IDs used only for the live-fetch fallback when all Redis paths fail.
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

  logger.warn({ chain, symbol }, '[gas-price] all price paths failed — returning 0')
  return 0
}

// ── TRON balance ──────────────────────────────────────────────────────────────

async function getTronBalanceTRX(address: string): Promise<number> {
  const url = `${env.TRON_FULLNODE_URL}/v1/accounts/${encodeURIComponent(address)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TronGrid accounts API error: HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Array<{ balance?: number }> }
  const balanceSun = data.data?.[0]?.balance ?? 0
  return balanceSun / 1_000_000  // SUN → TRX
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
