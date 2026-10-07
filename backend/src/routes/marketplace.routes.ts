import type { FastifyInstance } from 'fastify'
import * as marketplaceService from '../services/marketplace.service'
import { getRecentTrades } from '../services/marketplace.service'
import { getNumberConfig } from '../services/platformFlags.service'

export async function marketplaceRoutes(app: FastifyInstance) {
  // All routes are public (no auth required)

  // Edge/browser caching for the read-only public snapshots. Cloudflare sits in
  // front of the API but only caches what a Cache Rule opts in; these headers
  // set how long it may reuse each response. Short TTLs + stale-while-revalidate
  // keep prices fresh while sparing a Singapore round trip on most reads.
  // /ads is deliberately excluded — listings go inactive quickly.
  const PUBLIC_CACHE: Record<string, string> = {
    '/rates': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
    '/rates/summary': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
    '/rates/usdt-insight': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
    '/rates/usdt-reference': 'public, max-age=10, s-maxage=20, stale-while-revalidate=60',
    '/rates/usdt-history': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    '/stats': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    '/top-ads': 'public, max-age=10, s-maxage=15, stale-while-revalidate=30',
    '/config': 'public, max-age=30, s-maxage=60, stale-while-revalidate=120',
    '/recent-trades': 'public, max-age=15, s-maxage=30, stale-while-revalidate=60',
  }
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200 || reply.hasHeader('Cache-Control')) return payload
    const path = req.url.split('?')[0]!.replace(/\/+$/, '')
    const key = Object.keys(PUBLIC_CACHE).find((k) => path.endsWith(`/marketplace${k}`) || path === k)
    if (key) reply.header('Cache-Control', PUBLIC_CACHE[key]!)
    return payload
  })

  app.get('/rate/:coin', async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const data = await marketplaceService.getRateCoin(coin.toUpperCase())
    return reply.send({ success: true, data })
  })

  app.get('/rates', async (_req, reply) => {
    const data = await marketplaceService.getAllRates()
    return reply.send({ success: true, data })
  })

  // Internal listing-based rate summary — powers the homepage market calculator
  app.get('/rates/summary', async (_req, reply) => {
    const data = await marketplaceService.getMarketRatesSummary()
    return reply.send({ success: true, data })
  })

  // USDT market insight (our own active listings) + the configured price-margin
  // band — powers the create-ad insight box. Public, no auth.
  app.get('/rates/usdt-insight', async (_req, reply) => {
    const [insight, marginPct] = await Promise.all([
      marketplaceService.getUsdtMarketInsight(),
      getNumberConfig('usdt_price_margin_pct', 5),
    ])
    return reply.send({ success: true, data: { ...insight, marginPct } })
  })

  // Marketplace USDT→PKR reference rate derived from real activity on this
  // platform (median of recent trades → active listings → FX spot). Public.
  app.get('/rates/usdt-reference', async (_req, reply) => {
    const data = await marketplaceService.getUsdtReferenceRate()
    return reply.send({ success: true, data })
  })

  // USDT price history (OHLC / line) from completed USDT trades on this platform,
  // for the marketplace price chart. ?range=24h|7d|30d|90d|1y|all. Public.
  app.get('/rates/usdt-history', async (req, reply) => {
    const raw = (req.query as { range?: string }).range ?? '30d'
    const valid = ['24h', '7d', '30d', '90d', '1y', 'all'] as const
    const range = (valid as readonly string[]).includes(raw) ? (raw as typeof valid[number]) : '30d'
    const data = await marketplaceService.getUsdtPriceHistory(range)
    return reply.send({ success: true, data })
  })

  app.get('/stats', async (_req, reply) => {
    const data = await marketplaceService.getStats()
    return reply.send({ success: true, data })
  })

  app.get('/top-ads', async (_req, reply) => {
    const data = await marketplaceService.getTopAds()
    return reply.send({ success: true, data })
  })

  app.get('/config', async (_req, reply) => {
    const data = await marketplaceService.getPublicConfig()
    return reply.send({ success: true, data })
  })

  app.get('/recent-trades', async (_req, reply) => {
    const data = await getRecentTrades()
    return reply.send({ success: true, data })
  })

  app.get('/ads', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const resolvedSide = query.side ?? query.type
    const data = await marketplaceService.getAds({
      page: query.page ? parseInt(query.page, 10) : 1,
      limit: Math.min(query.limit ? parseInt(query.limit, 10) : 20, 50),
      ...(resolvedSide !== undefined ? { side: resolvedSide } : {}),
      ...(query.coin ? { coin: query.coin.toUpperCase() } : {}),
      ...(query.network ? { network: query.network } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.minAmount ? { minAmount: parseFloat(query.minAmount) } : {}),
      ...(query.maxAmount ? { maxAmount: parseFloat(query.maxAmount) } : {}),
      ...(query.merchantId ? { merchantId: query.merchantId } : {}),
      ...(query.seller ? { seller: query.seller } : {}),
    })
    return reply.send({ success: true, data })
  })
}
