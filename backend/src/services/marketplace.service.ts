import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { Errors } from '../lib/errors'
import { Prisma } from '@prisma/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateCoinResult {
  rate: number
  updatedAt: string
  source: 'live' | 'cached'
}

export interface AllRatesResult {
  rates: Record<string, number>
  updatedAt: string
}

export interface PlatformStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  activeMerchants: number
}

export interface SellerInfo {
  id: string
  username: string
  badge: string
  tradeStats: {
    completionRate: string
    totalTrades: number
    avgRating: string
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
      const parsed = JSON.parse(cached) as { rate: number; updatedAt: string }
      return { rate: parsed.rate, updatedAt: parsed.updatedAt, source: 'live' }
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
    source: 'cached',
  }
}

export async function getAllRates(): Promise<AllRatesResult> {
  const keys = await redis.keys('rate:*')

  const rates: Record<string, number> = {}
  let updatedAt = new Date().toISOString()

  if (keys.length > 0) {
    const values = await redis.mget(...keys)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const val = values[i]
      if (!val || !key) continue
      const coinName = key.replace('rate:', '').toUpperCase()
      if (coinName === 'USD_PKR') continue // internal key
      try {
        const parsed = JSON.parse(val) as { rate: number; updatedAt: string }
        rates[coinName] = parsed.rate
        updatedAt = parsed.updatedAt
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
    }
  }

  return { rates, updatedAt }
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

  const [users, trades, volume, merchants] = await Promise.all([
    db.user.count({ where: { isEmailVerified: true } }),
    db.trade.count({ where: { status: { in: ['crypto_released'] } } }),
    db.trade.aggregate({ _sum: { fiatAmount: true }, where: { status: 'crypto_released' } }),
    db.merchant.count({ where: { status: 'approved' } }),
  ])

  const result: PlatformStats = {
    totalUsers: users,
    totalTrades: trades,
    totalVolume: (volume._sum.fiatAmount ?? new Prisma.Decimal(0)).toString(),
    activeMerchants: merchants,
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
  return result
}

export async function getTopAds(): Promise<{ buys: AdWithSeller[]; sells: AdWithSeller[] }> {
  const cacheKey = 'top-ads'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as { buys: AdWithSeller[]; sells: AdWithSeller[] }
    } catch {
      // fall through
    }
  }

  const sellerInclude = {
    select: {
      id: true,
      username: true,
      tradeStats: {
        select: {
          badge: true,
          completionRate: true,
          totalTrades: true,
          avgRating: true,
        },
      },
      collateralLocks: {
        where: { status: 'locked' as const },
        select: { id: true },
        take: 1,
      },
    },
  }

  const [buyAds, sellAds] = await Promise.all([
    db.ad.findMany({
      where: { status: 'active', side: 'buy' },
      orderBy: { price: 'desc' },
      take: 6,
      include: { user: sellerInclude },
    }),
    db.ad.findMany({
      where: { status: 'active', side: 'sell' },
      orderBy: { price: 'asc' },
      take: 6,
      include: { user: sellerInclude },
    }),
  ])

  function mapAd(ad: typeof buyAds[0]): AdWithSeller {
    const stats = ad.user.tradeStats
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
        badge: stats?.badge ?? 'new',
        tradeStats: stats
          ? {
              completionRate: stats.completionRate.toString(),
              totalTrades: stats.totalTrades,
              avgRating: stats.avgRating.toString(),
            }
          : null,
        hasCollateral: ad.user.collateralLocks.length > 0,
      },
    }
  }

  const result = {
    buys: buyAds.map(mapAd),
    sells: sellAds.map(mapAd),
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
    kycLimitEnhancedDaily: parseFloat(map['kyc_limit_enhanced_daily'] ?? '500000'),
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

  const where: Prisma.AdWhereInput = {
    status: 'active',
    ...(params.side ? { side: params.side as 'buy' | 'sell' } : {}),
    ...(params.coin ? { coin: params.coin } : {}),
    ...(params.network ? { network: params.network } : {}),
    ...(params.paymentMethod ? { paymentMethods: { has: params.paymentMethod } } : {}),
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
      tradeStats: {
        select: {
          badge: true,
          completionRate: true,
          totalTrades: true,
          avgRating: true,
        },
      },
      collateralLocks: {
        where: { status: 'locked' as const },
        select: { id: true },
        take: 1,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: AdWithSeller[] = (rawItems as any[]).map((ad) => {
    const stats = ad.user.tradeStats
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
        badge: stats?.badge ?? 'new',
        tradeStats: stats
          ? {
              completionRate: stats.completionRate.toString(),
              totalTrades: stats.totalTrades,
              avgRating: stats.avgRating.toString(),
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
