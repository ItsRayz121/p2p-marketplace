import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { getUsdtReferenceRate } from '../services/marketplace.service'
import { buildPriceHistory, priceRangeStart, type PriceRange } from '../lib/priceHistory'
import type { CtmTokenStatus, CtmTokenRiskTier, CtmSettlementType } from '@prisma/client'

export interface ListTokensFilters {
  search?: string
  settlementType?: CtmSettlementType
  riskTier?: CtmTokenRiskTier
  status?: CtmTokenStatus
  page?: number
  limit?: number
  adminView?: boolean
}

export async function listApprovedTokens(filters: ListTokensFilters = {}) {
  const { search, settlementType, riskTier, status, page = 1, limit = 20, adminView = false } = filters
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = adminView ? {} : { status: 'approved', isListingEnabled: true }
  if (search) where.OR = [
    { name: { contains: search, mode: 'insensitive' } },
    { symbol: { contains: search, mode: 'insensitive' } },
  ]
  if (settlementType) where.settlementType = settlementType
  if (riskTier) where.riskTier = riskTier
  if (status && adminView) where.status = status

  const [tokens, total] = await Promise.all([
    db.ctmToken.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ totalVolumePkr: 'desc' }, { createdAt: 'desc' }],
    }),
    db.ctmToken.count({ where }),
  ])

  return { tokens, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTokenBySlug(slug: string) {
  const token = await db.ctmToken.findUnique({
    where: { slug },
    include: {
      _count: {
        select: {
          listings: { where: { status: 'active' } },
          requests: { where: { status: 'open' } },
        },
      },
    },
  })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)
  return token
}

export async function adminCreateToken(adminId: string, data: {
  slug: string
  symbol: string
  name: string
  description: string
  logoUrl?: string
  bannerUrl?: string
  settlementType: CtmSettlementType
  network?: string
  contractAddress?: string
  explorerUrl?: string
  addressExample?: string
  addressRegex?: string
  officialWebsite?: string
  officialTwitter?: string
  officialTelegram?: string
  whitePaperUrl?: string
  riskTier?: CtmTokenRiskTier
  riskNotes?: string
  riskLabels?: string[]
  maxListingAmount?: number
  minTradeAmountPkr?: number
}) {
  const existing = await db.ctmToken.findUnique({ where: { slug: data.slug } })
  if (existing) throw new AppError('CONFLICT', 'Token with this slug already exists', 409)

  return db.ctmToken.create({
    data: {
      ...data,
      status: 'approved',
      addedByAdminId: adminId,
    },
  })
}

export async function adminUpdateToken(adminId: string, tokenId: string, data: {
  status?: CtmTokenStatus
  name?: string
  symbol?: string
  description?: string
  logoUrl?: string
  bannerUrl?: string
  settlementType?: CtmSettlementType
  network?: string
  contractAddress?: string
  explorerUrl?: string
  addressExample?: string
  addressRegex?: string
  officialWebsite?: string
  officialTwitter?: string
  officialTelegram?: string
  whitePaperUrl?: string
  riskTier?: CtmTokenRiskTier
  riskNotes?: string
  riskLabels?: string[]
  isListingEnabled?: boolean
  maxListingAmount?: number
  minTradeAmountPkr?: number
}) {
  const token = await db.ctmToken.findUnique({ where: { id: tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)

  return db.ctmToken.update({
    where: { id: tokenId },
    data: {
      ...data,
      ...(data.status === 'approved' ? { verifiedByAdminId: adminId, verifiedAt: new Date() } : {}),
    },
  })
}

export async function adminDelistToken(adminId: string, tokenId: string) {
  const token = await db.ctmToken.findUnique({ where: { id: tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)

  await db.$transaction([
    db.ctmToken.update({ where: { id: tokenId }, data: { status: 'delisted', isListingEnabled: false } }),
    db.ctmListing.updateMany({ where: { tokenId, status: 'active' }, data: { status: 'paused' } }),
  ])

  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_TOKEN_DELISTED', metadata: { tokenId, tokenName: token.name } },
  }).catch(() => {})
}

export async function submitTokenRequest(userId: string, data: {
  tokenName: string
  tokenSymbol: string
  description: string
  officialWebsite?: string
  evidenceUrl?: string
}) {
  return db.ctmTokenRequest.create({ data: { userId, ...data } })
}

export async function listTokenRequests(filters: { status?: string | undefined; page?: number | undefined; limit?: number | undefined } = {}) {
  const { status, page = 1, limit = 20 } = filters
  const where = status ? { status } : {}
  const skip = (page - 1) * limit
  const [requests, total] = await Promise.all([
    db.ctmTokenRequest.findMany({
      where,
      skip,
      take: limit,
      include: { user: { select: { id: true, username: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.ctmTokenRequest.count({ where }),
  ])
  return { requests, total, page, limit }
}

export async function approveTokenRequest(adminId: string, requestId: string, tokenData: Parameters<typeof adminCreateToken>[1]) {
  const request = await db.ctmTokenRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError('NOT_FOUND', 'Token request not found', 404)
  if (request.status !== 'pending') throw new AppError('CONFLICT', 'Request is not pending', 409)

  const token = await adminCreateToken(adminId, tokenData)

  await db.ctmTokenRequest.update({
    where: { id: requestId },
    data: { status: 'approved', reviewedBy: adminId, reviewedAt: new Date(), tokenId: token.id },
  })

  return token
}

export async function rejectTokenRequest(adminId: string, requestId: string, adminNote: string) {
  const request = await db.ctmTokenRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError('NOT_FOUND', 'Token request not found', 404)
  if (request.status !== 'pending') throw new AppError('CONFLICT', 'Request is not pending', 409)

  return db.ctmTokenRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', reviewedBy: adminId, reviewedAt: new Date(), adminNote },
  })
}

export interface MarketInsight {
  avg12h: number | null
  buyAvg12h: number | null
  sellAvg12h: number | null
  previous12hAvg: number | null
  changePercent: number | null
  /** Short-window momentum: avg price in the last 1h vs the prior 1h. */
  changePercent1h: number | null
  lastTradePrice: number | null
  lastTradedAt: string | null
  /** Last ~30 completed trade prices, oldest→newest, for a sparkline. */
  recentPrices: { price: number; at: string }[]
  dataSource: 'completed_trades' | 'active_listings' | 'none'
  sampleSize: number
  lowData: boolean
}

export async function getTokenMarketInsight(tokenId: string): Promise<MarketInsight> {
  const now = new Date()
  const h1ago = new Date(now.getTime() - 1 * 60 * 60 * 1000)
  const h2ago = new Date(now.getTime() - 2 * 60 * 60 * 1000)
  const h12ago = new Date(now.getTime() - 12 * 60 * 60 * 1000)
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  // Last ~30 completed trades (any time) → sparkline series, oldest→newest.
  const sparkTrades = await db.ctmTrade.findMany({
    where: { tokenId, status: 'completed', completedAt: { not: null } },
    select: { pricePerUnit: true, completedAt: true },
    orderBy: { completedAt: 'desc' },
    take: 30,
  })
  const recentPrices = sparkTrades
    .slice()
    .reverse()
    .map((t) => ({
      price: parseFloat(parseFloat(t.pricePerUnit.toString()).toFixed(6)),
      at: (t.completedAt as Date).toISOString(),
    }))

  // Current 12h completed trades
  const recentTrades = await db.ctmTrade.findMany({
    where: {
      tokenId,
      status: 'completed',
      completedAt: { gte: h12ago },
    },
    select: {
      pricePerUnit: true,
      completedAt: true,
      listing: { select: { side: true } },
    },
    orderBy: { completedAt: 'desc' },
  })

  // 1h momentum derived in-memory from the 12h set (no extra query): avg of the
  // last hour vs the hour before it.
  const avgOf = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const last1h = recentTrades
    .filter((t) => t.completedAt && t.completedAt >= h1ago)
    .map((t) => parseFloat(t.pricePerUnit.toString()))
  const prev1h = recentTrades
    .filter((t) => t.completedAt && t.completedAt >= h2ago && t.completedAt < h1ago)
    .map((t) => parseFloat(t.pricePerUnit.toString()))
  const last1hAvg = avgOf(last1h)
  const prev1hAvg = avgOf(prev1h)
  const changePercent1h = last1hAvg !== null && prev1hAvg !== null && prev1hAvg !== 0
    ? parseFloat((((last1hAvg - prev1hAvg) / prev1hAvg) * 100).toFixed(2))
    : null

  // Previous 12h completed trades (for change%)
  const prevTrades = await db.ctmTrade.findMany({
    where: {
      tokenId,
      status: 'completed',
      completedAt: { gte: h24ago, lt: h12ago },
    },
    select: { pricePerUnit: true },
  })

  if (recentTrades.length >= 1) {
    const prices = recentTrades.map((t) => parseFloat(t.pricePerUnit.toString()))
    const buyPrices = recentTrades
      .filter((t) => t.listing?.side === 'buy')
      .map((t) => parseFloat(t.pricePerUnit.toString()))
    const sellPrices = recentTrades
      .filter((t) => t.listing?.side === 'sell')
      .map((t) => parseFloat(t.pricePerUnit.toString()))

    const avg12h = prices.reduce((a, b) => a + b, 0) / prices.length
    const buyAvg12h = buyPrices.length > 0 ? buyPrices.reduce((a, b) => a + b, 0) / buyPrices.length : null
    const sellAvg12h = sellPrices.length > 0 ? sellPrices.reduce((a, b) => a + b, 0) / sellPrices.length : null

    let previous12hAvg: number | null = null
    let changePercent: number | null = null
    if (prevTrades.length >= 1) {
      const prevPrices = prevTrades.map((t) => parseFloat(t.pricePerUnit.toString()))
      previous12hAvg = prevPrices.reduce((a, b) => a + b, 0) / prevPrices.length
      // Guard against a zero baseline (parity with changePercent1h) so a degenerate
      // 0-price average can't yield Infinity/NaN and render as "Infinity%".
      changePercent = previous12hAvg !== 0 ? ((avg12h - previous12hAvg) / previous12hAvg) * 100 : null
    }

    const lastTrade = recentTrades[0]
    return {
      avg12h: parseFloat(avg12h.toFixed(2)),
      buyAvg12h: buyAvg12h !== null ? parseFloat(buyAvg12h.toFixed(2)) : null,
      sellAvg12h: sellAvg12h !== null ? parseFloat(sellAvg12h.toFixed(2)) : null,
      previous12hAvg: previous12hAvg !== null ? parseFloat(previous12hAvg.toFixed(2)) : null,
      changePercent: changePercent !== null ? parseFloat(changePercent.toFixed(2)) : null,
      changePercent1h,
      lastTradePrice: lastTrade ? parseFloat(parseFloat(lastTrade.pricePerUnit.toString()).toFixed(2)) : null,
      lastTradedAt: lastTrade?.completedAt?.toISOString() ?? null,
      recentPrices,
      dataSource: 'completed_trades',
      sampleSize: recentTrades.length,
      lowData: recentTrades.length < 3,
    }
  }

  // Fallback: active listings
  const activeListings = await db.ctmListing.findMany({
    where: { tokenId, status: 'active' },
    select: { pricePerUnit: true, side: true },
  })

  if (activeListings.length >= 1) {
    const allPrices = activeListings.map((l) => parseFloat(l.pricePerUnit.toString()))
    const buyPrices = activeListings.filter((l) => l.side === 'buy').map((l) => parseFloat(l.pricePerUnit.toString()))
    const sellPrices = activeListings.filter((l) => l.side === 'sell').map((l) => parseFloat(l.pricePerUnit.toString()))
    const avg12h = allPrices.reduce((a, b) => a + b, 0) / allPrices.length

    return {
      avg12h: parseFloat(avg12h.toFixed(2)),
      buyAvg12h: buyPrices.length > 0 ? parseFloat((buyPrices.reduce((a, b) => a + b, 0) / buyPrices.length).toFixed(2)) : null,
      sellAvg12h: sellPrices.length > 0 ? parseFloat((sellPrices.reduce((a, b) => a + b, 0) / sellPrices.length).toFixed(2)) : null,
      previous12hAvg: null,
      changePercent: null,
      changePercent1h,
      lastTradePrice: null,
      lastTradedAt: null,
      recentPrices,
      dataSource: 'active_listings',
      sampleSize: activeListings.length,
      lowData: activeListings.length < 3,
    }
  }

  return {
    avg12h: null,
    buyAvg12h: null,
    sellAvg12h: null,
    previous12hAvg: null,
    changePercent: null,
    changePercent1h,
    lastTradePrice: null,
    lastTradedAt: null,
    recentPrices,
    dataSource: 'none',
    sampleSize: 0,
    lowData: true,
  }
}

// ─── Price history (OHLC / line series) ──────────────────────────────────────
// Source of truth = completed CTM trades on THIS platform (prices in PKR). The
// client converts to USDT with usdtPkrRate. Bucketing is shared with the USDT
// marketplace chart via lib/priceHistory so the two never drift.

export type CtmPriceRange = PriceRange

export interface CtmPriceHistory {
  range: CtmPriceRange
  /** Prices are returned in PKR; multiply by (1 / usdtPkrRate) for USDT. */
  currency: 'PKR'
  usdtPkrRate: number | null
  candles: { t: string; o: number; h: number; l: number; c: number; n: number }[]
  points: { t: string; p: number }[]
  tradeCount: number
  bucketMs: number
  from: string
  to: string
  hasCandles: boolean
}

export async function getTokenPriceHistory(tokenId: string, range: CtmPriceRange): Promise<CtmPriceHistory> {
  const now = new Date()

  // For "all", anchor the window on the token's earliest completed trade.
  let earliest: Date | null = null
  if (range === 'all') {
    const first = await db.ctmTrade.findFirst({
      where: { tokenId, status: 'completed', completedAt: { not: null } },
      select: { completedAt: true },
      orderBy: { completedAt: 'asc' },
    })
    earliest = first?.completedAt ?? null
  }
  const from = priceRangeStart(range, now, earliest)

  const rows = await db.ctmTrade.findMany({
    where: { tokenId, status: 'completed', completedAt: { gte: from, lte: now } },
    select: { pricePerUnit: true, completedAt: true },
    orderBy: { completedAt: 'asc' },
  })
  const trades = rows.map((r) => ({
    price: parseFloat(parseFloat(r.pricePerUnit.toString()).toFixed(6)),
    at: r.completedAt as Date,
  }))

  const history = buildPriceHistory(trades, range, from, now)
  const usdtPkrRate = (await getUsdtReferenceRate()).rate

  return { ...history, currency: 'PKR', usdtPkrRate }
}
