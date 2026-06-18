import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { Errors } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { isPubliclyVisible, type ChainReadinessState } from '../lib/gas/chainMeta'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateCoinResult {
  rate: number
  updatedAt: string
  source: string        // e.g. 'coingecko' | 'kraken' | 'bybit' | 'binance' | 'stale-cache' | 'db'
}

export interface AllRatesResult {
  rates: Record<string, number>
  updatedAt: string
  source: string
}

export interface PlatformStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  verifiedTraders: number
  todayTrades: number
}

export interface SellerInfo {
  id: string
  username: string
  fullName: string | null
  avatarUrl: string | null
  badge: string
  lastSeenAt: string | null
  joinedAt: string | null
  isMerchant: boolean
  merchantId: string | null
  merchantName: string | null
  tradeStats: {
    completionRate: string
    totalTrades: number
    completedTrades: number
    avgRating: string
    avgResponseMinutes: number | null
    avgReleaseMinutes: number | null
    totalVolumePKR: string | null
    totalReviews: number | null
  } | null
  hasCollateral: boolean
}

export interface AdWithSeller {
  id: string
  side: string
  coin: string
  network: string
  priceType: string
  price: string
  floatOffset: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  tradeWindow: number
  terms: string
  status: string
  createdAt: Date
  seller: SellerInfo
}

export interface PublicConfig {
  siteNotice: string | null
  siteNoticeType: string | null
  geoBlockEnabled: boolean
  referralRewardPkr: number
  homeFaqs: unknown[]
  kycLimitBasicDaily: number
  kycLimitEnhancedDaily: number
  nonCustodialP2p: boolean
  nonCustodialMaxOrderUsdt: number
}

export interface GetAdsParams {
  side?: string
  coin?: string
  network?: string
  paymentMethod?: string
  minAmount?: number
  maxAmount?: number
  page?: number
  limit?: number
  merchantId?: string
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Service functions ────────────────────────────────────────────────────────

export async function getRateCoin(coin: string): Promise<RateCoinResult> {
  const redisKey = `rate:${coin.toUpperCase()}`

  // 1. Try Redis
  const cached = await redis.get(redisKey)
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { rate: number; updatedAt: string; source?: string }
      return {
        rate: parsed.rate,
        updatedAt: parsed.updatedAt,
        source: parsed.source ?? 'live',
      }
    } catch {
      // fall through
    }
  }

  // 2. Fall back to PlatformConfig
  const dbKey = `rate_${coin.toUpperCase()}_PKR`
  const config = await db.platformConfig.findUnique({ where: { key: dbKey } })
  if (!config) {
    throw Errors.NOT_FOUND(`Rate for ${coin}`)
  }

  return {
    rate: parseFloat(config.value),
    updatedAt: config.updatedAt.toISOString(),
    source: 'db',
  }
}

export async function getAllRates(): Promise<AllRatesResult> {
  const keys = await redis.keys('rate:*')

  const rates: Record<string, number> = {}
  let updatedAt = new Date().toISOString()
  let source = 'live'

  if (keys.length > 0) {
    const values = await redis.mget(...keys)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const val = values[i]
      if (!val || !key) continue
      const coinName = key.replace('rate:', '').toUpperCase()
      if (coinName === 'USD_PKR') continue // internal key
      try {
        const parsed = JSON.parse(val) as { rate: number; updatedAt: string; source?: string }
        rates[coinName] = parsed.rate
        updatedAt = parsed.updatedAt
        if (parsed.source) source = parsed.source
      } catch {
        const numVal = parseFloat(val)
        if (!isNaN(numVal)) rates[coinName] = numVal
      }
    }
  }

  // Fall back to PlatformConfig for any missing known coins
  const KNOWN_COINS = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL', 'TRX', 'AVAX', 'TON']
  const missingCoins = KNOWN_COINS.filter(c => rates[c] === undefined)

  if (missingCoins.length > 0) {
    const configs = await db.platformConfig.findMany({
      where: { key: { in: missingCoins.map(c => `rate_${c}_PKR`) } },
    })
    for (const cfg of configs) {
      const coin = cfg.key.replace('rate_', '').replace('_PKR', '')
      rates[coin] = parseFloat(cfg.value)
      updatedAt = cfg.updatedAt.toISOString()
      if (missingCoins.length === KNOWN_COINS.length) source = 'db'
    }
  }

  return { rates, updatedAt, source }
}

export async function getStats(): Promise<PlatformStats> {
  const cacheKey = 'stats:platform'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as PlatformStats
    } catch {
      // fall through
    }
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [users, trades, volume, verifiedTraders, todayTrades] = await Promise.all([
    db.user.count({ where: { isEmailVerified: true } }),
    db.trade.count({ where: { status: { in: ['crypto_released'] } } }),
    db.trade.aggregate({ _sum: { fiatAmount: true }, where: { status: 'crypto_released' } }),
    db.user.count({ where: { kycStatus: 'approved' } }),
    db.trade.count({ where: { status: 'crypto_released', updatedAt: { gte: todayStart } } }),
  ])

  const result: PlatformStats = {
    totalUsers: users,
    totalTrades: trades,
    totalVolume: (volume._sum.fiatAmount ?? new Prisma.Decimal(0)).toString(),
    verifiedTraders,
    todayTrades,
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
  return result
}

export interface RecentTrade {
  id: string
  amount: string
  coin: string
  completedAt: string
  buyerUsername: string
  sellerUsername: string
  buyerFullName: string | null
  sellerFullName: string | null
}

export async function getRecentTrades(): Promise<RecentTrade[]> {
  const cacheKey = 'marketplace:recent-trades'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as RecentTrade[]
    } catch {
      // fall through
    }
  }

  const trades = await db.trade.findMany({
    where: { status: 'crypto_released', coin: 'USDT' },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      amount: true,
      coin: true,
      updatedAt: true,
      buyer: { select: { username: true, fullName: true } },
      seller: { select: { username: true, fullName: true } },
    },
  })

  const result: RecentTrade[] = trades.map((t) => ({
    id: t.id,
    amount: t.amount.toString(),
    coin: t.coin,
    completedAt: t.updatedAt.toISOString(),
    buyerUsername: t.buyer.username,
    sellerUsername: t.seller.username,
    buyerFullName: t.buyer.fullName ?? null,
    sellerFullName: t.seller.fullName ?? null,
  }))

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 30)
  return result
}

type OffersMode = 'top' | 'latest' | 'pinned'

/** Trust-based score used to rank "top recommended" offers. */
function offerScore(ad: AdWithSeller): number {
  const s = ad.seller.tradeStats
  if (!s) return 0
  const completion = parseFloat(s.completionRate) || 0
  const rating = parseFloat(s.avgRating) || 0
  return (s.completedTrades * 2) + (completion * 100) + (rating * 10)
}

export async function getTopAds(): Promise<{
  buys: AdWithSeller[]
  sells: AdWithSeller[]
  usdt: AdWithSeller[]
  mode: OffersMode
}> {
  const cacheKey = 'top-ads:v2'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as { buys: AdWithSeller[]; sells: AdWithSeller[]; usdt: AdWithSeller[]; mode: OffersMode }
    } catch {
      // fall through
    }
  }

  // Admin-controlled ranking for the homepage "USDT Marketplace" section.
  const cfgRows = await db.platformConfig.findMany({
    where: { key: { in: ['home_offers_mode', 'home_pinned_ad_ids'] } },
    select: { key: true, value: true },
  })
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]))
  const rawMode = (cfg['home_offers_mode'] ?? 'top').trim().toLowerCase()
  const mode: OffersMode = (['top', 'latest', 'pinned'].includes(rawMode) ? rawMode : 'top') as OffersMode
  const pinnedIds = (cfg['home_pinned_ad_ids'] ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const sellerInclude = {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      createdAt: true,
      lastSeenAt: true,
      tradeStats: {
        select: {
          badge: true,
          completionRate: true,
          totalTrades: true,
          completedTrades: true,
          avgRating: true,
          avgResponseMinutes: true,
          avgReleaseMinutes: true,
          totalVolumePKR: true,
          totalReviews: true,
        },
      },
      collateralLocks: {
        where: { status: 'locked' as const },
        select: { id: true },
        take: 1,
      },
      merchant: {
        select: { id: true, businessName: true, status: true },
      },
    },
  }

  const [buyAds, sellAds, poolAds] = await Promise.all([
    db.ad.findMany({
      where: { status: 'active', side: 'buy', coin: 'USDT' },
      orderBy: { price: 'desc' },
      take: 6,
      include: { user: sellerInclude },
    }),
    db.ad.findMany({
      where: { status: 'active', side: 'sell', coin: 'USDT' },
      orderBy: { price: 'asc' },
      take: 6,
      include: { user: sellerInclude },
    }),
    // Pool of recent active USDT offers (both sides) used to build the unified
    // "USDT Marketplace" section per the admin-selected ranking mode.
    db.ad.findMany({
      where: { status: 'active', coin: 'USDT' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: { user: sellerInclude },
    }),
  ])

  function mapAd(ad: typeof buyAds[0]): AdWithSeller {
    const stats = ad.user.tradeStats
    const merchant = ad.user.merchant
    return {
      id: ad.id,
      side: ad.side,
      coin: ad.coin,
      network: ad.network,
      priceType: ad.priceType,
      price: ad.price.toString(),
      floatOffset: ad.floatOffset.toString(),
      availableAmount: ad.availableAmount.toString(),
      minOrder: ad.minOrder.toString(),
      maxOrder: ad.maxOrder.toString(),
      paymentMethods: ad.paymentMethods,
      tradeWindow: ad.tradeWindow,
      terms: ad.terms,
      status: ad.status,
      createdAt: ad.createdAt,
      seller: {
        id: ad.user.id,
        username: ad.user.username,
        fullName: (ad.user as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (ad.user as { avatarUrl?: string | null }).avatarUrl ?? null,
        badge: stats?.badge ?? 'new',
        lastSeenAt: ad.user.lastSeenAt?.toISOString() ?? null,
        joinedAt: (ad.user as { createdAt?: Date | null }).createdAt?.toISOString() ?? null,
        isMerchant: !!merchant && merchant.status === 'approved',
        merchantId: merchant?.status === 'approved' ? (merchant.id ?? null) : null,
        merchantName: merchant?.status === 'approved' ? (merchant.businessName ?? null) : null,
        tradeStats: stats
          ? {
              completionRate: stats.completionRate.toString(),
              totalTrades: stats.totalTrades,
              completedTrades: stats.completedTrades,
              avgRating: stats.avgRating.toString(),
              avgResponseMinutes: stats.avgResponseMinutes ?? null,
              avgReleaseMinutes: stats.avgReleaseMinutes ?? null,
              totalVolumePKR: stats.totalVolumePKR?.toString() ?? null,
              totalReviews: stats.totalReviews ?? null,
            }
          : null,
        hasCollateral: ad.user.collateralLocks.length > 0,
      },
    }
  }

  // Build the unified USDT list per the admin-selected ranking mode.
  const pool = poolAds.map(mapAd) // already newest-first from the query
  const HOME_LIMIT = 4
  let usdt: AdWithSeller[]
  if (mode === 'latest') {
    usdt = pool.slice(0, HOME_LIMIT)
  } else if (mode === 'pinned' && pinnedIds.length > 0) {
    const byId = new Map(pool.map((a) => [a.id, a]))
    const pinned = pinnedIds.map((id) => byId.get(id)).filter((a): a is AdWithSeller => Boolean(a))
    // Fill remaining slots with top-ranked offers not already pinned.
    const pinnedSet = new Set(pinned.map((a) => a.id))
    const filler = [...pool].filter((a) => !pinnedSet.has(a.id)).sort((a, b) => offerScore(b) - offerScore(a))
    usdt = [...pinned, ...filler].slice(0, HOME_LIMIT)
  } else {
    // 'top' (default): rank by trust score.
    usdt = [...pool].sort((a, b) => offerScore(b) - offerScore(a)).slice(0, HOME_LIMIT)
  }

  const result = {
    buys: buyAds.map(mapAd),
    sells: sellAds.map(mapAd),
    usdt,
    mode,
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 120)
  return result
}

export async function getPublicConfig(): Promise<PublicConfig> {
  const cacheKey = 'public-config'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as PublicConfig
    } catch {
      // fall through
    }
  }

  const configKeys = [
    'site_notice',
    'site_notice_type',
    'geo_block_enabled',
    'referral_reward_pkr',
    'home_faqs',
    'kyc_limit_basic_daily',
    'kyc_limit_enhanced_daily',
    'noncustodial_p2p_enabled',
    'noncustodial_max_order_usdt',
  ]

  const rows = await db.platformConfig.findMany({
    where: { key: { in: configKeys } },
  })

  const map: Record<string, string> = {}
  for (const row of rows) {
    map[row.key] = row.value
  }

  let homeFaqs: unknown[] = []
  try {
    homeFaqs = JSON.parse(map['home_faqs'] ?? '[]') as unknown[]
  } catch {
    homeFaqs = []
  }

  const result: PublicConfig = {
    siteNotice: map['site_notice'] ?? null,
    siteNoticeType: map['site_notice_type'] ?? null,
    geoBlockEnabled: map['geo_block_enabled'] === 'true',
    referralRewardPkr: parseFloat(map['referral_reward_pkr'] ?? '0'),
    homeFaqs,
    kycLimitBasicDaily: parseFloat(map['kyc_limit_basic_daily'] ?? '50000'),
    kycLimitEnhancedDaily: parseFloat(map['kyc_limit_enhanced_daily'] ?? '200000'),
    nonCustodialP2p: map['noncustodial_p2p_enabled'] === 'true',
    nonCustodialMaxOrderUsdt: parseFloat(map['noncustodial_max_order_usdt'] ?? '100'),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 60)
  return result
}

export interface AdsResult {
  ads: AdWithSeller[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export async function getAds(params: GetAdsParams): Promise<AdsResult> {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 50)
  const skip = (page - 1) * limit

  const ALLOWED_NETWORKS = ['BEP20', 'Aptos']

  // Resolve payment method type filter to matching IDs
  let paymentMethodIdFilter: string[] | undefined
  if (params.paymentMethod) {
    const matchingPms = await db.paymentMethod.findMany({
      where: { type: params.paymentMethod as any },
      select: { id: true },
    })
    paymentMethodIdFilter = matchingPms.map((pm) => pm.id)
  }

  const where: Prisma.AdWhereInput = {
    status: 'active',
    coin: 'USDT',
    ...(params.side ? { side: params.side as 'buy' | 'sell' } : {}),
    ...(params.network && ALLOWED_NETWORKS.includes(params.network) ? { network: params.network } : {}),
    ...(paymentMethodIdFilter
      ? paymentMethodIdFilter.length > 0
        ? { paymentMethods: { hasSome: paymentMethodIdFilter } }
        : { id: 'no-match' }
      : {}),
    ...(params.minAmount !== undefined ? { minOrder: { lte: new Prisma.Decimal(params.minAmount) } } : {}),
    ...(params.maxAmount !== undefined ? { maxOrder: { gte: new Prisma.Decimal(params.maxAmount) } } : {}),
    ...(params.merchantId
      ? {
          user: {
            merchant: { id: params.merchantId },
          },
        }
      : {}),
  }

  const sellerInclude = {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      createdAt: true,
      lastSeenAt: true,
      tradeStats: {
        select: {
          badge: true,
          completionRate: true,
          totalTrades: true,
          completedTrades: true,
          avgRating: true,
          avgResponseMinutes: true,
          avgReleaseMinutes: true,
          totalVolumePKR: true,
          totalReviews: true,
        },
      },
      collateralLocks: {
        where: { status: 'locked' as const },
        select: { id: true },
        take: 1,
      },
      merchant: {
        select: { id: true, businessName: true, status: true },
      },
    },
  }

  const [rawItems, total] = await Promise.all([
    db.ad.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: sellerInclude },
    }),
    db.ad.count({ where }),
  ])

  // Resolve payment method IDs to their type strings for display
  const allPmIds = [...new Set(rawItems.flatMap((ad) => ad.paymentMethods))]
  const pmTypeMap = new Map<string, string>()
  if (allPmIds.length > 0) {
    const pms = await db.paymentMethod.findMany({
      where: { id: { in: allPmIds } },
      select: { id: true, type: true },
    })
    for (const pm of pms) pmTypeMap.set(pm.id, pm.type)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: AdWithSeller[] = (rawItems as any[]).map((ad) => {
    const stats = ad.user.tradeStats
    const merchant = ad.user.merchant
    const resolvedMethods = [...new Set(
      (ad.paymentMethods as string[]).map((id) => pmTypeMap.get(id) ?? id)
    )]
    return {
      id: ad.id,
      side: ad.side,
      coin: ad.coin,
      network: ad.network,
      priceType: ad.priceType,
      price: ad.price.toString(),
      floatOffset: ad.floatOffset.toString(),
      availableAmount: ad.availableAmount.toString(),
      minOrder: ad.minOrder.toString(),
      maxOrder: ad.maxOrder.toString(),
      paymentMethods: resolvedMethods,
      tradeWindow: ad.tradeWindow,
      terms: ad.terms,
      status: ad.status,
      createdAt: ad.createdAt,
      seller: {
        id: ad.user.id,
        username: ad.user.username,
        fullName: (ad.user as { fullName?: string | null }).fullName ?? null,
        avatarUrl: (ad.user as { avatarUrl?: string | null }).avatarUrl ?? null,
        badge: stats?.badge ?? 'new',
        lastSeenAt: ad.user.lastSeenAt?.toISOString() ?? null,
        joinedAt: (ad.user as { createdAt?: Date | null }).createdAt?.toISOString() ?? null,
        isMerchant: !!merchant && merchant.status === 'approved',
        merchantId: merchant?.status === 'approved' ? (merchant.id ?? null) : null,
        merchantName: merchant?.status === 'approved' ? (merchant.businessName ?? null) : null,
        tradeStats: stats
          ? {
              completionRate: stats.completionRate.toString(),
              totalTrades: stats.totalTrades,
              completedTrades: stats.completedTrades,
              avgRating: stats.avgRating.toString(),
              avgResponseMinutes: stats.avgResponseMinutes ?? null,
              avgReleaseMinutes: stats.avgReleaseMinutes ?? null,
              totalVolumePKR: stats.totalVolumePKR?.toString() ?? null,
              totalReviews: stats.totalReviews ?? null,
            }
          : null,
        hasCollateral: ad.user.collateralLocks.length > 0,
      },
    }
  })

  return {
    ads: items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

// ─── Market Rates Summary (internal listing-based) ──────────────────────────────
//
// Powers the homepage "RupChain Market Calculator". Every rate is derived from
// RupChain's own active listings — NO external price API is consulted:
//   • USDT      — average PKR price across active USDT marketplace ads
//   • CTM       — average pricePerUnit (PKR) across active listings, per token
//   • Gas fees  — platform selling price of each public chain's native gas token
//
// USD→PKR conversions use the internal USDT marketplace average (falling back to
// the cached rate:USD_PKR only when no active USDT listings exist).

export interface MarketRateUsdt {
  averagePkrRate: number | null
  listingCount: number
}

export interface MarketRateToken {
  symbol: string
  name: string
  slug: string
  averageUsdtRate: number | null
  averagePkrRate: number | null
  listingCount: number
}

export interface MarketRatesSummary {
  usdt: MarketRateUsdt
  communityTokens: MarketRateToken[]
  gasFees: MarketRateToken[]
  updatedAt: string
}

const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP'])

// Reads a native token's live USD price from Redis (same source the gas page
// uses). Stablecoins are pegged 1:1. Returns 0 when no usable price is cached —
// callers treat 0 as "no rate available" and never show a fabricated price.
async function readUsdPrice(symbol: string): Promise<number> {
  const sym = symbol.toUpperCase()
  if (STABLE_SYMBOLS.has(sym)) return 1
  const raw = await redis.get(`rate:${sym}`)
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as { usdPrice?: number }
    return parsed.usdPrice && parsed.usdPrice > 0 ? parsed.usdPrice : 0
  } catch {
    return 0
  }
}

export async function getMarketRatesSummary(): Promise<MarketRatesSummary> {
  const cacheKey = 'market-rates-summary'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as MarketRatesSummary
    } catch {
      // fall through
    }
  }

  const now = new Date()

  // Only the latest 20 active/updated listings feed each average, so the rate
  // reflects current market conditions rather than stale historical listings.
  const RATE_SAMPLE_SIZE = 20

  // ── 1. USDT marketplace — average PKR price across the latest 20 active listings ──
  const usdtListings = await db.ad.findMany({
    where: { status: 'active', coin: 'USDT' },
    orderBy: { updatedAt: 'desc' },
    take: RATE_SAMPLE_SIZE,
    select: { price: true },
  })
  const usdtCount = usdtListings.length
  const usdtAvgPkr = usdtCount > 0
    ? usdtListings.reduce((sum, l) => sum + Number(l.price), 0) / usdtCount
    : null

  // USD→PKR conversion factor: prefer the internal USDT listing average; fall
  // back to the cached rate:USD_PKR only when no active USDT listings exist.
  let usdPkr: number | null = usdtAvgPkr && usdtAvgPkr > 0 ? usdtAvgPkr : null
  if (usdPkr === null) {
    const raw = await redis.get('rate:USD_PKR')
    const parsed = raw ? parseFloat(raw) : NaN
    usdPkr = !isNaN(parsed) && parsed > 0 ? parsed : null
  }

  // ── 2. Community tokens — average price across the latest 20 active listings per token ──
  // First find which tokens currently have active listings, then average each
  // token's most-recently-updated 20 listings (not its entire history).
  const ctmTokenIds = await db.ctmListing.groupBy({
    by: ['tokenId'],
    where: {
      status: 'active',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  })

  const tokenIds = ctmTokenIds.map((g) => g.tokenId)
  const tokens = tokenIds.length
    ? await db.ctmToken.findMany({
        where: { id: { in: tokenIds } },
        select: { id: true, symbol: true, name: true, slug: true },
      })
    : []
  const tokenMap = new Map(tokens.map((t) => [t.id, t]))

  const communityTokens: MarketRateToken[] = (
    await Promise.all(
      tokenIds.map(async (tokenId): Promise<MarketRateToken | null> => {
        const meta = tokenMap.get(tokenId)
        if (!meta) return null
        const listings = await db.ctmListing.findMany({
          where: {
            tokenId,
            status: 'active',
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: { updatedAt: 'desc' },
          take: RATE_SAMPLE_SIZE,
          select: { pricePerUnit: true },
        })
        const count = listings.length
        const avgPkr = count > 0
          ? listings.reduce((sum, l) => sum + Number(l.pricePerUnit), 0) / count
          : null
        return {
          symbol: meta.symbol,
          name: meta.name,
          slug: meta.slug,
          averagePkrRate: avgPkr,
          averageUsdtRate: avgPkr !== null && usdPkr ? avgPkr / usdPkr : null,
          listingCount: count,
        }
      }),
    )
  )
    .filter((x): x is MarketRateToken => x !== null)
    .sort((a, b) => b.listingCount - a.listingCount)

  // ── 3. Gas fees — platform price of each public chain's native gas token ──
  // Gas is a platform-run service (not a P2P listing market), so the "rate" is
  // the live native-token price the platform sells at — exactly what the /gas
  // page quotes. PKR is derived via the internal USD→PKR factor above.
  const gasChains = await db.gasChainConfig.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: 'asc' },
    include: {
      tokens: {
        where: { isActive: true, tokenType: 'native' },
        orderBy: { displayOrder: 'asc' },
        take: 1,
      },
    },
  })

  const gasFees: MarketRateToken[] = []
  for (const chain of gasChains) {
    const state = (chain.readinessState ?? 'inactive') as ChainReadinessState
    if (!isPubliclyVisible(state)) continue
    const native = chain.tokens[0]
    if (!native) continue
    const usd = await readUsdPrice(native.priceSymbol)
    if (usd <= 0) continue // never show a fabricated price
    gasFees.push({
      symbol: chain.symbol,
      name: `${chain.name} Gas`,
      slug: chain.slug,
      averageUsdtRate: usd,
      averagePkrRate: usdPkr ? usd * usdPkr : null,
      listingCount: 1,
    })
  }

  const result: MarketRatesSummary = {
    usdt: { averagePkrRate: usdtAvgPkr, listingCount: usdtCount },
    communityTokens,
    gasFees,
    updatedAt: now.toISOString(),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 60)
  return result
}
