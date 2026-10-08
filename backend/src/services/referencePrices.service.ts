import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

/**
 * Global REFERENCE prices (CoinGecko) for the public Markets pages — 7-day price movement in USD.
 *
 * This is deliberately separate from the platform's own trade history. Local trade prices stay
 * labelled as platform data; nothing here is ever blended into them, and nothing is ever
 * synthesised: an asset with no verified provider id returns `unsupported`, a provider outage with
 * nothing cached returns `unavailable`, and the UI shows "Market data unavailable" for both.
 *
 * Market-data failures can never touch payments, gas orders or trading: this module is only called
 * from the read-only /markets/reference route, every failure is caught, and no money path imports it.
 *
 * ── Cost / usage ────────────────────────────────────────────────────────────────────────────────
 * One batched `/coins/markets` call covers every asset that needs refreshing (up to 250 ids), and each
 * asset is cached for FRESH_SECONDS. The worst case is therefore one call per FRESH_SECONDS no matter
 * how much traffic the pages get: 86 400 / 900 = 96 calls/day ≈ 2 900/month. CTM contract verification
 * is a one-off lookup per token (cached 7 days on success, 6 hours on "not listed") and adds a handful of
 * calls per month. That fits inside CoinGecko's free Demo allowance (10 000 calls/month, 30/min) with
 * headroom; the public keyless endpoint is shared and may rate-limit sooner, in which case stale data is
 * served with its timestamp. No paid plan is purchased or required.
 */

const FRESH_SECONDS = 15 * 60
const STALE_KEEP_SECONDS = 3 * 24 * 3600
const BACKOFF_SECONDS = 10 * 60
const MAX_ATTEMPTS = 3
const SPARK_POINTS = 56 // downsampled from CoinGecko's 168 hourly points (7 d)
const BACKOFF_KEY = 'refprice:backoff'

/** Static ids for the native assets the platform already prices (same ids rateUpdater.job.ts uses). */
const NATIVE_IDS: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', TRX: 'tron', AVAX: 'avalanche-2',
  MATIC: 'matic-network', POL: 'matic-network', TON: 'the-open-network', SUI: 'sui', APT: 'aptos', NEAR: 'near',
}

/** CtmToken.network label → CoinGecko asset-platform id (used for contract verification). */
const NETWORK_TO_PLATFORM: Record<string, string> = {
  BEP20: 'binance-smart-chain', BSC: 'binance-smart-chain', BNB: 'binance-smart-chain',
  ERC20: 'ethereum', ETH: 'ethereum', ETHEREUM: 'ethereum',
  TRC20: 'tron', TRON: 'tron',
  POLYGON: 'polygon-pos', MATIC: 'polygon-pos',
  ARBITRUM: 'arbitrum-one', ARB: 'arbitrum-one',
  OPTIMISM: 'optimistic-ethereum', OP: 'optimistic-ethereum',
  BASE: 'base', AVALANCHE: 'avalanche', AVAX: 'avalanche',
  SOL: 'solana', SOLANA: 'solana', SPL: 'solana',
  APTOS: 'aptos', SUI: 'sui', TON: 'the-open-network',
}

export interface ReferenceData {
  providerId: string
  price: number
  /** % change over the last 7 days — the same period the chart shows. */
  change7dPct: number | null
  points: number[]
  /** When the provider says the price was last updated. */
  lastUpdated: string
  /** When RupChain last fetched it from the provider. */
  fetchedAt: string
}

export type ReferenceItem =
  | ({ slug: string; status: 'ok'; provider: 'CoinGecko'; currency: 'USD'; period: '7d'; stale: boolean; verifiedBy: 'provider_id' | 'contract' } & ReferenceData)
  | { slug: string; status: 'unsupported'; reason: 'not_applicable' | 'no_provider_id' | 'contract_not_verified' | 'unknown_asset' }
  | { slug: string; status: 'unavailable'; reason: 'provider_error' | 'rate_limited' }

function baseAndHeaders(): { base: string; headers: Record<string, string> } {
  // Same convention as the rate updater: a configured key means the Pro host.
  if (env.COINGECKO_API_KEY) return { base: 'https://pro-api.coingecko.com/api/v3', headers: { 'x-cg-pro-api-key': env.COINGECKO_API_KEY } }
  return { base: 'https://api.coingecko.com/api/v3', headers: {} }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class RateLimited extends Error {}

/** GET with a hard timeout and bounded retries (429 / 5xx / network). Never throws anything but RateLimited or Error. */
async function cgGet<T>(path: string): Promise<T> {
  const { base, headers } = baseAndHeaders()
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) })
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await redis.set(BACKOFF_KEY, '1', 'EX', Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : BACKOFF_SECONDS).catch(() => {})
        throw new RateLimited('CoinGecko rate limit')
      }
      if (res.status >= 500) throw new Error(`CoinGecko ${res.status}`)
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`) // 4xx other than 429 is not retryable
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
      if (err instanceof RateLimited) throw err
      if (err instanceof Error && /CoinGecko 4\d\d/.test(err.message)) throw err
      if (attempt < MAX_ATTEMPTS - 1) await sleep(400 * 2 ** attempt)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('CoinGecko request failed')
}

function downsample(points: number[]): number[] {
  if (points.length <= SPARK_POINTS) return points
  const out: number[] = []
  const step = (points.length - 1) / (SPARK_POINTS - 1)
  for (let i = 0; i < SPARK_POINTS; i++) out.push(points[Math.round(i * step)]!)
  return out
}

interface CgMarket {
  id: string
  current_price: number | null
  last_updated: string | null
  price_change_percentage_7d_in_currency?: number | null
  sparkline_in_7d?: { price: number[] }
}

const cacheKey = (id: string) => `refprice:v1:${id}`

async function readCache(ids: string[]): Promise<Map<string, ReferenceData>> {
  const out = new Map<string, ReferenceData>()
  if (ids.length === 0) return out
  try {
    const raws = await redis.mget(ids.map(cacheKey))
    raws.forEach((raw, i) => {
      if (!raw) return
      try { out.set(ids[i]!, JSON.parse(raw) as ReferenceData) } catch { /* ignore a corrupt entry */ }
    })
  } catch { /* cache miss is fine */ }
  return out
}

const isFresh = (d: ReferenceData) => Date.now() - new Date(d.fetchedAt).getTime() < FRESH_SECONDS * 1000

/** Refresh `ids` with ONE batched request; returns whichever ids the provider answered for. */
async function refresh(ids: string[]): Promise<Map<string, ReferenceData>> {
  const fresh = new Map<string, ReferenceData>()
  if (ids.length === 0) return fresh
  const rows = await cgGet<CgMarket[]>(
    `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(','))}&sparkline=true&price_change_percentage=7d&per_page=250&page=1`,
  )
  const fetchedAt = new Date().toISOString()
  const pipeline = redis.pipeline()
  for (const r of rows) {
    const points = r.sparkline_in_7d?.price?.filter((n) => Number.isFinite(n)) ?? []
    if (r.current_price == null || points.length < 2) continue // a flat/empty series is not a chart — treat as unavailable
    const d: ReferenceData = {
      providerId: r.id,
      price: r.current_price,
      change7dPct: typeof r.price_change_percentage_7d_in_currency === 'number' ? Math.round(r.price_change_percentage_7d_in_currency * 100) / 100 : null,
      points: downsample(points),
      lastUpdated: r.last_updated ?? fetchedAt,
      fetchedAt,
    }
    fresh.set(r.id, d)
    pipeline.set(cacheKey(r.id), JSON.stringify(d), 'EX', STALE_KEEP_SECONDS)
  }
  await pipeline.exec().catch(() => {})
  return fresh
}

/** Verify a CTM token's contract on its own chain; returns the provider id only when chain AND address both match. */
async function verifyContract(token: { id: string; network: string | null; contractAddress: string | null }): Promise<string | null | 'error'> {
  const platform = token.network ? NETWORK_TO_PLATFORM[token.network.trim().toUpperCase()] : undefined
  const address = token.contractAddress?.trim()
  if (!platform || !address) return null
  const key = `refprice:contract:${token.id}:${platform}:${address}`
  try {
    const hit = await redis.get(key)
    if (hit) return hit === 'none' ? null : hit
  } catch { /* fall through to a live lookup */ }
  try {
    const res = await cgGet<{ id?: string; platforms?: Record<string, string> }>(`/coins/${platform}/contract/${encodeURIComponent(address)}`)
    const onChain = res.platforms?.[platform]
    // EVM addresses are case-insensitive; Tron/Solana/Aptos/Sui/TON are not, so compare exactly unless it is 0x-hex.
    const same = onChain && (/^0x[0-9a-f]+$/i.test(address) ? onChain.toLowerCase() === address.toLowerCase() : onChain === address)
    const id = res.id && same ? res.id : null
    await redis.set(key, id ?? 'none', 'EX', id ? 7 * 24 * 3600 : 6 * 3600).catch(() => {})
    return id
  } catch (err) {
    // A 404 means CoinGecko doesn't list that contract on that chain — a definite "unsupported".
    if (err instanceof Error && /CoinGecko 404/.test(err.message)) {
      await redis.set(key, 'none', 'EX', 6 * 3600).catch(() => {})
      return null
    }
    return 'error' // provider trouble: don't cache, don't claim unsupported
  }
}

interface Resolved { slug: string; providerId: string; verifiedBy: 'provider_id' | 'contract' }

async function resolveSlug(slug: string): Promise<Resolved | ReferenceItem> {
  const lower = slug.toLowerCase()
  if (lower === 'usdt') return { slug, status: 'unsupported', reason: 'not_applicable' } // priced in PKR from local trades; a global $1 chart adds nothing

  const token = await db.ctmToken.findFirst({
    where: { slug: lower, status: 'approved', isListingEnabled: true },
    select: { id: true, network: true, contractAddress: true },
  })
  if (token) {
    const v = await verifyContract(token)
    if (v === 'error') return { slug, status: 'unavailable', reason: 'provider_error' }
    return v ? { slug, providerId: v, verifiedBy: 'contract' } : { slug, status: 'unsupported', reason: 'contract_not_verified' }
  }

  // Gas-fee native assets: admin-set CoinGecko id (token override, then chain) wins; else the static native map.
  const sym = lower.toUpperCase()
  const gas = await db.gasTokenConfig.findFirst({
    where: { priceSymbol: sym, isActive: true, isVisibleToUsers: true, isArchived: false },
    select: { coingeckoId: true, tokenType: true, chain: { select: { coingeckoId: true } } },
  })
  if (!gas) return { slug, status: 'unsupported', reason: 'unknown_asset' }
  // Non-native tokens identified only by symbol would be ambiguous — require an explicit id for them.
  const id = gas.coingeckoId ?? (gas.tokenType === 'native' ? gas.chain.coingeckoId ?? NATIVE_IDS[sym] : undefined) ?? undefined
  return id ? { slug, providerId: id, verifiedBy: 'provider_id' } : { slug, status: 'unsupported', reason: 'no_provider_id' }
}

const isResolved = (r: Resolved | ReferenceItem): r is Resolved => 'providerId' in r

export async function getReferencePrices(slugs: string[]): Promise<ReferenceItem[]> {
  const unique = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))].slice(0, 60)
  const resolved = await Promise.all(unique.map((s) => resolveSlug(s).catch((): ReferenceItem => ({ slug: s, status: 'unavailable', reason: 'provider_error' }))))

  const ids = [...new Set(resolved.filter(isResolved).map((r) => r.providerId))]
  const cached = await readCache(ids)
  const needRefresh = ids.filter((id) => !cached.has(id) || !isFresh(cached.get(id)!))

  let failure: 'provider_error' | 'rate_limited' | null = null
  const refreshed = new Map<string, ReferenceData>()
  if (needRefresh.length > 0) {
    const backedOff = await redis.get(BACKOFF_KEY).catch(() => null)
    if (backedOff) failure = 'rate_limited'
    else {
      try { for (const [k, v] of await refresh(needRefresh)) refreshed.set(k, v) }
      catch (err) {
        failure = err instanceof RateLimited ? 'rate_limited' : 'provider_error'
        logger.warn({ err, ids: needRefresh.length }, 'reference price refresh failed — serving stale cache where available')
      }
    }
  }

  return resolved.map((r): ReferenceItem => {
    if (!isResolved(r)) return r
    const fresh = refreshed.get(r.providerId)
    const data = fresh ?? cached.get(r.providerId)
    if (!data) return { slug: r.slug, status: 'unavailable', reason: failure ?? 'provider_error' }
    // "stale" = we wanted newer data but could not get it.
    const stale = !fresh && !isFresh(data)
    return { slug: r.slug, status: 'ok', provider: 'CoinGecko', currency: 'USD', period: '7d', stale, verifiedBy: r.verifiedBy, ...data }
  })
}
