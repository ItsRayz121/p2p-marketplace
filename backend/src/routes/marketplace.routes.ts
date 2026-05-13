import type { FastifyInstance } from 'fastify'
import * as marketplaceService from '../services/marketplace.service'

export async function marketplaceRoutes(app: FastifyInstance) {
  // All routes are public (no auth required)

  app.get('/rate/:coin', async (req, reply) => {
    const { coin } = req.params as { coin: string }
    const data = await marketplaceService.getRateCoin(coin.toUpperCase())
    return reply.send({ success: true, data })
  })

  app.get('/rates', async (_req, reply) => {
    const data = await marketplaceService.getAllRates()
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

  app.get('/ads', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>
    const data = await marketplaceService.getAds({
      page: query.page ? parseInt(query.page, 10) : 1,
      limit: Math.min(query.limit ? parseInt(query.limit, 10) : 20, 50),
      ...(query.side || query.type ? { side: query.side ?? query.type } : {}),
      ...(query.coin ? { coin: query.coin.toUpperCase() } : {}),
      ...(query.network ? { network: query.network } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.minAmount ? { minAmount: parseFloat(query.minAmount) } : {}),
      ...(query.maxAmount ? { maxAmount: parseFloat(query.maxAmount) } : {}),
      ...(query.merchantId ? { merchantId: query.merchantId } : {}),
    })
    return reply.send({ success: true, data })
  })
}
