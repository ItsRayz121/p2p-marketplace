import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { getMarketRatesSummary, getUsdtReferenceRate, getUsdtPriceHistory } from './marketplace.service'
import { getTokenMarketInsight, getTokenPriceHistory, getTokenBySlug } from '../ctm/ctm.token.service'

// ─── Markets overview ─────────────────────────────────────────────────────────
// Single public, cached snapshot that powers the /markets landing page: one row
// per tradable asset (USDT + every approved, listing-enabled CTM token), each
// with a last price (PKR + USDT-equivalent), a 24h change, buy/sell averages,
// and a short sparkline — all derived from real trades/listings on THIS
// platform (no external price feed). A newly approved CTM token appears here
// automatically; nothing to wire up.
//
// The 24h change reuses the avg(last ~12h) vs avg(previous ~12h) comparison
// already computed by getTokenMarketInsight / the USDT equivalent below — a
// deliberate choice: a true point-in-time "now vs 24h ago" would need one more
// buildPriceHistory query per token in this hot, unauthenticated, list-wide
// endpoint, which measurably slowed the cold path against this DB's latency.
// Comparing two 12h windows spans the same 24h lookback and is also more
// stable for the low-volume tokens this platform mostly has today. The
// detail-page activity endpoint below still computes real 24h high/low/volume
// per-token, since that only runs for the one token being viewed.

export interface MarketRow {
  kind: 'usdt' | 'ctm' | 'gas'
  slug: string
  symbol: string
  name: string
  logoUrl: string | null
  lastPricePkr: number | null
  lastPriceUsdt: number | null
  buyPricePkr: number | null
  sellPricePkr: number | null
  changePercent24h: number | null
  sparkline: number[]
  totalVolumePkr: string | null
  totalTrades: number | null
  lastTradedAt: string | null
  dataSource: 'completed_trades' | 'active_listings' | 'live_market' | 'none'
  lowData: boolean
}

export interface MarketsOverview {
  rows: MarketRow[]
  usdtPkrRate: number | null
  updatedAt: string
}

function toUsdt(pricePkr: number | null, usdtPkrRate: number | null): number | null {
  if (pricePkr === null || !usdtPkrRate) return null
  return parseFloat((pricePkr / usdtPkrRate).toFixed(6))
}

async function getUsdtInsight(): Promise<{
  changePercent24h: number | null
  lastTradePrice: number | null
  lastTradedAt: string | null
  recentPrices: number[]
  dataSource: 'completed_trades' | 'none'
  sampleSize: number
  lowData: boolean
}> {
  const now = new Date()
  const h12ago = new Date(now.getTime() - 12 * 60 * 60 * 1000)
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [sparkTrades, recentTrades, prevTrades] = await Promise.all([
    db.trade.findMany({
      where: { coin: 'USDT', status: 'crypto_released', releasedAt: { not: null } },
      select: { price: true, releasedAt: true },
      orderBy: { releasedAt: 'desc' },
      take: 30,
    }),
    db.trade.findMany({
      where: { coin: 'USDT', status: 'crypto_released', releasedAt: { gte: h12ago } },
      select: { price: true },
    }),
    db.trade.findMany({
      where: { coin: 'USDT', status: 'crypto_released', releasedAt: { gte: h24ago, lt: h12ago } },
      select: { price: true },
    }),
  ])

  const recentPrices = sparkTrades.slice().reverse().map((t) => Number(t.price))
  const last = sparkTrades[0]

  let changePercent24h: number | null = null
  if (recentTrades.length >= 1 && prevTrades.length >= 1) {
    const avg12h = recentTrades.reduce((a, t) => a + Number(t.price), 0) / recentTrades.length
    const prevAvg = prevTrades.reduce((a, t) => a + Number(t.price), 0) / prevTrades.length
    changePercent24h = prevAvg !== 0 ? parseFloat((((avg12h - prevAvg) / prevAvg) * 100).toFixed(2)) : null
  }

  return {
    changePercent24h,
    lastTradePrice: last ? parseFloat(Number(last.price).toFixed(2)) : null,
    lastTradedAt: last?.releasedAt ? last.releasedAt.toISOString() : null,
    recentPrices,
    dataSource: sparkTrades.length ? 'completed_trades' : 'none',
    sampleSize: sparkTrades.length,
    lowData: sparkTrades.length < 3,
  }
}

// ─── Gas fee tokens ───────────────────────────────────────────────────────────
// Rows for the native tokens the Gas Fee product sells (BNB, TRX, SOL, TON, SUI,
// APT, ETH, ...). Unlike USDT/CTM above, these aren't traded P2P on this
// platform — there's no order book to average — so the price is the same live
// external market price (rate:{SYMBOL} in Redis) that already drives Gas Fee
// checkout, refreshed every 5 minutes by rateUpdater.job.ts. No 24h change or
// sparkline yet: Redis only ever holds the current value, not a history.
// Stablecoins are skipped (USDT already has its own row above; the rest peg to
// $1 and would just be duplicate noise).

const GAS_STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP'])

async function getGasTokenRows(excludeSlugs: Set<string>): Promise<MarketRow[]> {
  const chains = await db.gasChainConfig.findMany({
    where: { isVisibleToUsers: true, isArchived: false },
    include: {
      tokens: { where: { isActive: true, isVisibleToUsers: true, isArchived: false }, orderBy: { displayOrder: 'asc' } },
    },
  })

  const seen = new Map<string, { name: string; logoUrl: string | null }>()
  for (const chain of chains) {
    for (const token of chain.tokens) {
      const sym = token.priceSymbol.toUpperCase()
      if (GAS_STABLECOIN_SYMBOLS.has(sym)) continue
      if (excludeSlugs.has(sym.toLowerCase())) continue
      if (!seen.has(sym)) seen.set(sym, { name: token.name, logoUrl: token.logoUrl ?? chain.logoUrl ?? null })
    }
  }
  if (seen.size === 0) return []

  const symbols = [...seen.keys()]
  const cachedRates = await redis.mget(symbols.map((s) => `rate:${s}`))

  return symbols.map((sym, i) => {
    const meta = seen.get(sym)!
    let pricePkr: number | null = null
    let priceUsdt: number | null = null
    let updatedAt: string | null = null
    const raw = cachedRates[i]
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { rate?: number; usdPrice?: number; updatedAt?: string }
        pricePkr = typeof parsed.rate === 'number' ? parsed.rate : null
        priceUsdt = typeof parsed.usdPrice === 'number' ? parsed.usdPrice : null
        updatedAt = parsed.updatedAt ?? null
      } catch { /* fall through to null prices below */ }
    }
    return {
      kind: 'gas',
      slug: sym.toLowerCase(),
      symbol: sym,
      name: meta.name,
      logoUrl: meta.logoUrl,
      lastPricePkr: pricePkr,
      lastPriceUsdt: priceUsdt,
      buyPricePkr: null,
      sellPricePkr: null,
      changePercent24h: null,
      sparkline: [],
      totalVolumePkr: null,
      totalTrades: null,
      lastTradedAt: updatedAt,
      dataSource: pricePkr !== null ? 'live_market' : 'none',
      lowData: false,
    }
  })
}

/** Is `symbol` a currently offered Gas Fee native token? Used so /markets/[slug] can
 * route a gas symbol to its own detail view instead of 404ing as an unknown CTM slug. */
async function isKnownGasSymbol(symbol: string): Promise<boolean> {
  const sym = symbol.toUpperCase()
  if (GAS_STABLECOIN_SYMBOLS.has(sym)) return false
  const count = await db.gasTokenConfig.count({
    where: {
      priceSymbol: sym,
      isActive: true,
      isVisibleToUsers: true,
      isArchived: false,
      chain: { isVisibleToUsers: true, isArchived: false },
    },
  })
  return count > 0
}

async function getGasTokenActivity(): Promise<MarketActivity> {
  return {
    buyOffers: 0,
    sellOffers: 0,
    bestBuyPkr: null,
    bestSellPkr: null,
    availableBuy: null,
    availableSell: null,
    high24hPkr: null,
    low24hPkr: null,
    volume24hUnits: null,
    recentTrades: [],
  }
}

export async function getMarketsOverview(): Promise<MarketsOverview> {
  const cacheKey = 'markets:overview'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) as MarketsOverview } catch { /* fall through */ }
  }

  const [ratesSummary, tokens, usdtInsight, usdtRate] = await Promise.all([
    getMarketRatesSummary(),
    db.ctmToken.findMany({
      where: { status: 'approved', isListingEnabled: true },
      orderBy: [{ totalVolumePkr: 'desc' }, { createdAt: 'desc' }],
    }),
    getUsdtInsight(),
    getUsdtReferenceRate(),
  ])

  const rateBySlug = new Map(ratesSummary.communityTokens.map((t) => [t.slug, t]))

  const tokenInsights = await Promise.all(tokens.map((t) => getTokenMarketInsight(t.id)))

  const ctmRows: MarketRow[] = tokens.map((t, i) => {
    const insight = tokenInsights[i] as Awaited<ReturnType<typeof getTokenMarketInsight>>
    const rates = rateBySlug.get(t.slug)
    const lastPricePkr = insight.lastTradePrice ?? insight.avg12h ?? rates?.buyPricePkr ?? rates?.sellPricePkr ?? null
    return {
      kind: 'ctm',
      slug: t.slug,
      symbol: t.symbol,
      name: t.name,
      logoUrl: t.logoUrl ?? null,
      lastPricePkr,
      lastPriceUsdt: toUsdt(lastPricePkr, usdtRate.rate),
      buyPricePkr: rates?.buyPricePkr ?? insight.buyAvg12h ?? null,
      sellPricePkr: rates?.sellPricePkr ?? insight.sellAvg12h ?? null,
      changePercent24h: insight.changePercent,
      sparkline: insight.recentPrices.map((p) => p.price),
      totalVolumePkr: t.totalVolumePkr.toString(),
      totalTrades: t.totalTrades,
      lastTradedAt: insight.lastTradedAt,
      dataSource: insight.dataSource,
      lowData: insight.lowData,
    }
  })

  const usdtLastPricePkr = usdtInsight.lastTradePrice ?? ratesSummary.usdt.buyRatePkr ?? ratesSummary.usdt.sellRatePkr ?? usdtRate.rate

  const usdtRow: MarketRow = {
    kind: 'usdt',
    slug: 'usdt',
    symbol: 'USDT',
    name: 'Tether USD',
    logoUrl: null,
    lastPricePkr: usdtLastPricePkr,
    lastPriceUsdt: 1,
    buyPricePkr: ratesSummary.usdt.buyRatePkr,
    sellPricePkr: ratesSummary.usdt.sellRatePkr,
    changePercent24h: usdtInsight.changePercent24h,
    sparkline: usdtInsight.recentPrices,
    totalVolumePkr: null,
    totalTrades: null,
    lastTradedAt: usdtInsight.lastTradedAt,
    // getUsdtInsight() only ever returns 'completed_trades' or 'none' (it never
    // queries active listings), so pass its real value through instead of
    // claiming a data source that was never computed.
    dataSource: usdtInsight.dataSource,
    lowData: usdtInsight.lowData,
  }

  const usedSlugs = new Set(['usdt', ...tokens.map((t) => t.slug.toLowerCase())])
  const gasRows = await getGasTokenRows(usedSlugs)

  const result: MarketsOverview = {
    rows: [usdtRow, ...ctmRows, ...gasRows],
    usdtPkrRate: usdtRate.rate,
    updatedAt: new Date().toISOString(),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', 45)
  return result
}

// ─── Per-token market activity (detail page) ─────────────────────────────────
// Order-book snapshot (active listings) + 24h high/low/volume + a recent-trades
// tape. Separate from the overview so the list page stays cheap — this only
// runs when someone opens a token's own page.

export interface MarketTrade {
  at: string
  amount: number
  pricePkr: number
  side: 'buy' | 'sell'
}

export interface MarketActivity {
  buyOffers: number
  sellOffers: number
  bestBuyPkr: number | null
  bestSellPkr: number | null
  availableBuy: number | null
  availableSell: number | null
  high24hPkr: number | null
  low24hPkr: number | null
  volume24hUnits: number | null
  recentTrades: MarketTrade[]
}

const ACTIVITY_TTL_SECONDS = 20

export async function getCtmTokenActivity(tokenId: string): Promise<MarketActivity> {
  const cacheKey = `markets:activity:ctm:${tokenId}`
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) as MarketActivity } catch { /* fall through */ }
  }

  const now = new Date()
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [listings, history, volumeAgg, recentTradesRaw] = await Promise.all([
    db.ctmListing.findMany({
      where: { tokenId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { side: true, pricePerUnit: true, availableAmount: true },
    }),
    getTokenPriceHistory(tokenId, '24h'),
    db.ctmTrade.aggregate({
      _sum: { tokenAmount: true },
      where: { tokenId, status: 'completed', completedAt: { gte: h24ago } },
    }),
    db.ctmTrade.findMany({
      where: { tokenId, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      take: 8,
      select: {
        tokenAmount: true,
        pricePerUnit: true,
        completedAt: true,
        listing: { select: { side: true } },
        // A trade may originate from a request instead of a listing (listingId is
        // nullable) — fall back to the request's own side so those trades aren't
        // mislabeled below.
        request: { select: { side: true } },
      },
    }),
  ])

  const buys = listings.filter((l) => l.side === 'buy')
  const sells = listings.filter((l) => l.side === 'sell')
  const realCandles = history.candles.filter((c) => c.n > 0)

  const result: MarketActivity = {
    buyOffers: buys.length,
    sellOffers: sells.length,
    bestBuyPkr: buys.length ? Math.max(...buys.map((l) => Number(l.pricePerUnit))) : null,
    bestSellPkr: sells.length ? Math.min(...sells.map((l) => Number(l.pricePerUnit))) : null,
    availableBuy: buys.length ? buys.reduce((a, l) => a + Number(l.availableAmount), 0) : null,
    availableSell: sells.length ? sells.reduce((a, l) => a + Number(l.availableAmount), 0) : null,
    high24hPkr: realCandles.length ? Math.max(...realCandles.map((c) => c.h)) : null,
    low24hPkr: realCandles.length ? Math.min(...realCandles.map((c) => c.l)) : null,
    volume24hUnits: volumeAgg._sum.tokenAmount ? Number(volumeAgg._sum.tokenAmount) : null,
    recentTrades: recentTradesRaw.map((t) => ({
      at: (t.completedAt as Date).toISOString(),
      amount: Number(t.tokenAmount),
      pricePkr: Number(t.pricePerUnit),
      side: (t.listing?.side ?? t.request?.side ?? 'sell') as 'buy' | 'sell',
    })),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', ACTIVITY_TTL_SECONDS)
  return result
}

export async function getUsdtActivity(): Promise<MarketActivity> {
  const cacheKey = 'markets:activity:usdt'
  const cached = await redis.get(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) as MarketActivity } catch { /* fall through */ }
  }

  const now = new Date()
  const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [ads, history, volumeAgg, recentTradesRaw] = await Promise.all([
    db.ad.findMany({ where: { status: 'active', coin: 'USDT' }, select: { side: true, price: true, availableAmount: true } }),
    getUsdtPriceHistory('24h'),
    db.trade.aggregate({
      _sum: { amount: true },
      where: { coin: 'USDT', status: 'crypto_released', releasedAt: { gte: h24ago } },
    }),
    db.trade.findMany({
      where: { coin: 'USDT', status: 'crypto_released' },
      orderBy: { releasedAt: 'desc' },
      take: 8,
      select: { amount: true, price: true, releasedAt: true, ad: { select: { side: true } } },
    }),
  ])

  const buys = ads.filter((a) => a.side === 'buy')
  const sells = ads.filter((a) => a.side === 'sell')
  const realCandles = history.candles.filter((c) => c.n > 0)

  const result: MarketActivity = {
    buyOffers: buys.length,
    sellOffers: sells.length,
    bestBuyPkr: buys.length ? Math.max(...buys.map((a) => Number(a.price))) : null,
    bestSellPkr: sells.length ? Math.min(...sells.map((a) => Number(a.price))) : null,
    availableBuy: buys.length ? buys.reduce((a, ad) => a + Number(ad.availableAmount), 0) : null,
    availableSell: sells.length ? sells.reduce((a, ad) => a + Number(ad.availableAmount), 0) : null,
    high24hPkr: realCandles.length ? Math.max(...realCandles.map((c) => c.h)) : null,
    low24hPkr: realCandles.length ? Math.min(...realCandles.map((c) => c.l)) : null,
    volume24hUnits: volumeAgg._sum.amount ? Number(volumeAgg._sum.amount) : null,
    recentTrades: recentTradesRaw.map((t) => ({
      at: (t.releasedAt as Date).toISOString(),
      amount: Number(t.amount),
      pricePkr: Number(t.price),
      side: (t.ad?.side ?? 'sell') as 'buy' | 'sell',
    })),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', ACTIVITY_TTL_SECONDS)
  return result
}

/** Resolves a /markets/[slug] activity lookup for 'usdt', a live gas-fee token symbol,
 * or a CTM token slug. Throws AppError NOT_FOUND (via getTokenBySlug) for an unknown slug. */
export async function getMarketActivityBySlug(slug: string): Promise<MarketActivity> {
  const lower = slug.toLowerCase()
  if (lower === 'usdt') return getUsdtActivity()

  // A CTM token's slug wins any collision with a gas-fee symbol (e.g. a
  // community token slugged "sol" or "trx") — same precedence the overview
  // uses when it excludes a gas row for a symbol an existing CTM slug already
  // claims. Checked with a cheap existence query rather than getTokenBySlug()
  // below, which throws NOT_FOUND (would require a throw/catch here).
  const ctmToken = await db.ctmToken.findUnique({ where: { slug: lower }, select: { id: true } })
  if (ctmToken) return getCtmTokenActivity(ctmToken.id)

  if (await isKnownGasSymbol(slug)) return getGasTokenActivity()

  const token = await getTokenBySlug(slug)
  return getCtmTokenActivity(token.id)
}
