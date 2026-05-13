import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'

export async function leaderboardRoutes(app: FastifyInstance) {
  // GET /api/leaderboard
  app.get('/leaderboard', async (req, reply) => {
    const query = req.query as Record<string, string>
    const type = (query.type as 'traders' | 'merchants') ?? 'traders'
    const period = (query.period as 'all' | 'month' | 'week') ?? 'all'
    const page = query.page ? parseInt(query.page, 10) : 1
    const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
    const skip = (page - 1) * limit

    let entries: unknown[]
    let total: number

    if (type === 'traders') {
      // Build date filter for period
      let dateFilter: Date | undefined
      if (period === 'week') {
        dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      } else if (period === 'month') {
        dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }

      const where = dateFilter ? { lastUpdated: { gte: dateFilter } } : {}

      const [stats, count] = await Promise.all([
        db.tradeStats.findMany({
          where,
          orderBy: [{ totalVolumePKR: 'desc' }, { completedTrades: 'desc' }],
          skip,
          take: limit,
          include: {
            user: {
              select: { id: true, username: true, createdAt: true },
            },
          },
        }),
        db.tradeStats.count({ where }),
      ])

      entries = stats.map((s, i) => ({
        rank: skip + i + 1,
        userId: s.userId,
        username: s.user.username,
        badge: s.badge,
        badgeLabel: s.badgeLabel,
        totalTrades: s.totalTrades,
        completedTrades: s.completedTrades,
        completionRate: s.completionRate,
        avgRating: s.avgRating,
        totalVolumePKR: s.totalVolumePKR,
        trustScore: s.trustScore,
        memberSince: s.user.createdAt,
      }))
      total = count
    } else {
      // Merchants leaderboard
      const [merchants, count] = await Promise.all([
        db.merchant.findMany({
          where: { status: 'approved' },
          orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
          skip,
          take: limit,
          include: {
            user: {
              select: {
                id: true,
                username: true,
                createdAt: true,
                tradeStats: {
                  select: {
                    totalTrades: true,
                    completedTrades: true,
                    completionRate: true,
                    avgRating: true,
                    totalVolumePKR: true,
                    badge: true,
                  },
                },
              },
            },
          },
        }),
        db.merchant.count({ where: { status: 'approved' } }),
      ])

      entries = merchants.map((m, i) => ({
        rank: skip + i + 1,
        merchantId: m.id,
        userId: m.userId,
        username: m.user.username,
        businessName: m.businessName,
        merchantRank: m.rank,
        spreadBps: m.spreadBps,
        disputeRate: m.disputeRate,
        stats: m.user.tradeStats,
        memberSince: m.user.createdAt,
      }))
      total = count
    }

    return reply.send({
      success: true,
      data: {
        type,
        period,
        entries,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })
}
