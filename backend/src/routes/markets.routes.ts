import type { FastifyInstance } from 'fastify'
import { getMarketsOverview, getMarketActivityBySlug } from '../services/markets.service'

// Public "Token Markets" overview — one cached snapshot combining USDT and every
// approved CTM token, used by the /markets landing page (list + SEO metadata).
export async function marketsRoutes(app: FastifyInstance) {
  app.get('/markets/overview', async (_req, reply) => {
    const data = await getMarketsOverview()
    // Backend already caches this snapshot ~45s; let the browser/CDN reuse it briefly too.
    reply.header('Cache-Control', 'public, max-age=10, s-maxage=20, stale-while-revalidate=60')
    return reply.send({ success: true, data })
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
