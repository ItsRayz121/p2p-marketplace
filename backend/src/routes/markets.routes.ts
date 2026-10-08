import type { FastifyInstance } from 'fastify'
import { getMarketsOverview, getMarketActivityBySlug } from '../services/markets.service'
import { getReferencePrices } from '../services/referencePrices.service'

// Public "Token Markets" overview — one cached snapshot combining USDT and every
// approved CTM token, used by the /markets landing page (list + SEO metadata).
export async function marketsRoutes(app: FastifyInstance) {
  app.get('/markets/overview', async (_req, reply) => {
    const data = await getMarketsOverview()
    // Backend already caches this snapshot ~45s; let the browser/CDN reuse it briefly too.
    reply.header('Cache-Control', 'public, max-age=10, s-maxage=20, stale-while-revalidate=60')
    return reply.send({ success: true, data })
  })

  // GET /markets/reference?slugs=eth,bnb,… — GLOBAL reference prices (CoinGecko, 7-day, USD) with sparkline points.
  // Read-only and fully isolated: it can only ever return data, 'unsupported' or 'unavailable', never an error that
  // reaches a payment/gas/trade path. Provider keys stay on the server.
  app.get('/markets/reference', async (req, reply) => {
    const raw = ((req.query as { slugs?: string }).slugs ?? '').split(',').slice(0, 60)
    let items: Awaited<ReturnType<typeof getReferencePrices>> = []
    try { items = await getReferencePrices(raw) } catch { /* never fail the page over market data */ }
    reply.header('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=900')
    return reply.send({ success: true, data: { items, source: 'CoinGecko', generatedAt: new Date().toISOString() } })
  })

  // GET /markets/:slug/activity — order-book snapshot (active listings) + 24h
  // high/low/volume + recent trades, for one token's detail page. 'usdt' is a
  // reserved slug for the USDT/PKR pair; anything else is looked up as a CTM
  // token slug (404s via AppError if unknown).
  app.get('/markets/:slug/activity', async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const data = await getMarketActivityBySlug(slug)
    return reply.send({ success: true, data })
  })
}
