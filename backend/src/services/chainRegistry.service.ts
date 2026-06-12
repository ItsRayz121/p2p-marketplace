/**
 * Chain Registry Service — DB-backed drop-in replacement for the static chains.ts arrays.
 *
 * Data lives in DepositChain + DepositToken tables. Redis cache (5-min TTL) sits in
 * front so every request does NOT hit Postgres. Call invalidateCache() after any
 * admin write to ensure subsequent reads see fresh data.
 *
 * getRpcUrl() and getMoralisStreamId() remain synchronous — they read env vars
 * directly, not the DB, so startup and reconciler callers are unaffected.
 */
import { db as prisma } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import type { ChainConfig, ChainFamily, TokenConfig } from '../lib/chains'

const CACHE_KEY = 'deposit_chains:all'
const CACHE_TTL = 300 // 5 minutes

// ── Internal helpers ──────────────────────────────────────────────────────────

function toChainConfig(row: {
  slug: string
  chainId: number | null
  name: string
  family: string
  nativeSymbol: string
  networkLabel: string
  minConfirmations: number
  explorerBase: string
  tokens: Array<{ symbol: string; address: string | null; decimals: number }>
}): ChainConfig {
  const base = {
    id:               row.slug,
    name:             row.name,
    family:           row.family as ChainFamily,
    nativeSymbol:     row.nativeSymbol,
    networkLabel:     row.networkLabel,
    minConfirmations: row.minConfirmations,
    explorerBase:     row.explorerBase,
    tokens:           row.tokens.map((t) => ({
      symbol:   t.symbol,
      address:  t.address,
      decimals: t.decimals,
    } satisfies TokenConfig)),
  }
  // exactOptionalPropertyTypes: only include chainId if it has a value
  return row.chainId != null
    ? { ...base, chainId: row.chainId } satisfies ChainConfig
    : base satisfies ChainConfig
}

async function fetchFromDb(): Promise<ChainConfig[]> {
  const rows = await prisma.depositChain.findMany({
    where:   { isActive: true },
    include: { tokens: { where: { isActive: true }, orderBy: { symbol: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(toChainConfig)
}

async function getCached(): Promise<ChainConfig[]> {
  try {
    const raw = await redis.get(CACHE_KEY)
    if (raw) return JSON.parse(raw) as ChainConfig[]
  } catch {
    // Redis miss or error — fall through to DB
  }
  const chains = await fetchFromDb()
  try {
    await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(chains))
  } catch {
    // Cache write failure is non-fatal
  }
  return chains
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getAllChains(): Promise<ChainConfig[]> {
  return getCached()
}

export async function getChainBySlug(slug: string): Promise<ChainConfig | null> {
  const chains = await getCached()
  return chains.find((c) => c.id === slug.toLowerCase()) ?? null
}

/** Alias matching the chains.ts function name. */
export async function getChainById(id: string): Promise<ChainConfig | null> {
  return getChainBySlug(id)
}

export async function getChainByNetworkLabel(network: string): Promise<ChainConfig | null> {
  const upper = network.toUpperCase()
  const chains = await getCached()
  return chains.find((c) => c.networkLabel === upper) ?? null
}

export async function isEvmNetwork(network: string): Promise<boolean> {
  const chain = await getChainByNetworkLabel(network)
  return chain?.family === 'EVM'
}

// Non-EVM explorers use different tx path segments (Aptos /txn, SUI /txblock,
// TRON /#/transaction, …). Admin-entered bases may already include that segment —
// in that case append only the hash; otherwise default to the EVM-style /tx/.
const TX_PATH_SUFFIX = /(\/(tx|txn|txs|transaction|transactions|txblock)|#\/transaction)\/?$/

export async function explorerTxUrl(chainId: string, txHash: string): Promise<string | undefined> {
  const chain = await getChainBySlug(chainId)
  if (!chain) return undefined
  const base = chain.explorerBase.replace(/\/+$/, '')
  return TX_PATH_SUFFIX.test(base) ? `${base}/${txHash}` : `${base}/tx/${txHash}`
}

export async function explorerAddressUrl(chainId: string, address: string): Promise<string | undefined> {
  const chain = await getChainBySlug(chainId)
  return chain ? `${chain.explorerBase}/address/${address}` : undefined
}

/** Wipes the Redis cache. Call this after any admin write to chain/token rows. */
export async function invalidateCache(): Promise<void> {
  await redis.del(CACHE_KEY)
}

// ── Sync helpers (env-var based — no DB needed) ───────────────────────────────

export function getRpcUrl(chainSlug: string): string | undefined {
  switch (chainSlug.toLowerCase()) {
    case 'ethereum': return env.ETHEREUM_RPC_URL
    case 'bsc':      return env.BSC_RPC_URL
    case 'polygon':  return env.POLYGON_RPC_URL
    case 'arbitrum': return env.ARBITRUM_RPC_URL
    case 'optimism': return env.OPTIMISM_RPC_URL
    case 'base':     return env.BASE_RPC_URL
    // Accept both 'avax' and 'avalanche' — admins have created the deposit chain
    // under either slug; the maps must resolve regardless of which was used.
    case 'avax':
    case 'avalanche': return env.AVALANCHE_RPC_URL
    default:         return undefined
  }
}

export function getMoralisStreamId(chainSlug: string): string | undefined {
  switch (chainSlug.toLowerCase()) {
    case 'ethereum': return env.MORALIS_STREAM_ID_ETHEREUM || undefined
    case 'bsc':      return env.MORALIS_STREAM_ID_BSC      || undefined
    case 'polygon':  return env.MORALIS_STREAM_ID_POLYGON  || undefined
    case 'arbitrum': return env.MORALIS_STREAM_ID_ARBITRUM || undefined
    case 'optimism': return env.MORALIS_STREAM_ID_OPTIMISM || undefined
    case 'base':     return env.MORALIS_STREAM_ID_BASE     || undefined
    default:         return undefined
  }
}
