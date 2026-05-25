import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'

type Period = 'all' | 'month' | 'week'
type TradeType = 'all' | 'usdt' | 'ctm' | 'gas'

function dateFilter(period: Period): Date | undefined {
  if (period === 'week') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  if (period === 'month') return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  return undefined
}

// Aggregate completed trades from a raw user-id array into ranked entries
function rankEntries(
  rows: { userId: string; username: string; completedTrades: number; totalVolumePKR: number }[],
  skip: number,
) {
  // Merge buyer + seller rows for the same user
  const map = new Map<string, { userId: string; username: string; completedTrades: number; totalVolumePKR: number }>()
  for (const r of rows) {
    const existing = map.get(r.userId)
    if (existing) {
      existing.completedTrades += r.completedTrades
      existing.totalVolumePKR += r.totalVolumePKR
    } else {
      map.set(r.userId, { ...r })
    }
  }
  return [...map.values()]
    .sort((a, b) => b.totalVolumePKR - a.totalVolumePKR || b.completedTrades - a.completedTrades)
    .map((e, i) => ({
      rank: skip + i + 1,
      userId: e.userId,
      username: e.username,
      completedTrades: e.completedTrades,
      totalVolumePKR: e.totalVolumePKR.toFixed(2),
    }))
}

export async function leaderboardRoutes(app: FastifyInstance) {
  // GET /api/leaderboard
  app.get('/leaderboard', async (req, reply) => {
    const query = req.query as Record<string, string>
    const type = (query.type as 'traders' | 'merchants') ?? 'traders'
    const period = (query.period as Period) ?? 'all'
    const tradeType = (query.tradeType as TradeType) ?? 'all'
    const page = query.page ? parseInt(query.page, 10) : 1
    const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
    const skip = (page - 1) * limit
    const since = dateFilter(period)

    let entries: unknown[]
    let total: number

    if (type === 'traders') {
      if (tradeType === 'all') {
        // Default: use the pre-computed TradeStats table (covers USDT + CTM once confirmReceipt updates it)
        const where = since ? { lastUpdated: { gte: since } } : {}
        const [stats, count] = await Promise.all([
          db.tradeStats.findMany({
            where,
            orderBy: [{ totalVolumePKR: 'desc' }, { completedTrades: 'desc' }],
            skip,
            take: limit,
            include: { user: { select: { id: true, username: true, createdAt: true } } },
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
      } else if (tradeType === 'ctm') {
        // Query CtmTrade table directly
        const tradeWhere = {
          status: 'completed' as const,
          ...(since ? { completedAt: { gte: since } } : {}),
        }
        const ctmTrades = await db.ctmTrade.findMany({
          where: tradeWhere,
          select: {
            buyerId: true, sellerId: true, fiatAmount: true,
            buyer: { select: { id: true, username: true } },
            seller: { select: { id: true, username: true } },
          },
        })
        const raw = [
          ...ctmTrades.map((t) => ({ userId: t.buyerId, username: t.buyer.username, completedTrades: 1, totalVolumePKR: Number(t.fiatAmount) })),
          ...ctmTrades.map((t) => ({ userId: t.sellerId, username: t.seller.username, completedTrades: 1, totalVolumePKR: Number(t.fiatAmount) })),
        ]
        const allRanked = rankEntries(raw, 0)
        total = allRanked.length
        entries = allRanked.slice(skip, skip + limit).map((e, i) => ({ ...e, rank: skip + i + 1 }))
      } else if (tradeType === 'usdt') {
        // Query USDT Trade table — final status is crypto_released
        const tradeWhere = {
          status: 'crypto_released' as const,
          ...(since ? { updatedAt: { gte: since } } : {}),
        }
        const usdtTrades = await db.trade.findMany({
          where: tradeWhere,
          select: {
            buyerId: true, sellerId: true, fiatAmount: true,
            buyer: { select: { id: true, username: true } },
            seller: { select: { id: true, username: true } },
          },
        })
        const raw = [
          ...usdtTrades.map((t) => ({ userId: t.buyerId, username: t.buyer.username, completedTrades: 1, totalVolumePKR: Number(t.fiatAmount) })),
          ...usdtTrades.map((t) => ({ userId: t.sellerId, username: t.seller.username, completedTrades: 1, totalVolumePKR: Number(t.fiatAmount) })),
        ]
        const allRanked = rankEntries(raw, 0)
        total = allRanked.length
        entries = allRanked.slice(skip, skip + limit).map((e, i) => ({ ...e, rank: skip + i + 1 }))
      } else {
        // gas tradeType: query GasFeeOrder
        const gasWhere = {
          status: 'delivered' as const,
          userId: { not: null },
          ...(since ? { deliveredAt: { gte: since } } : {}),
        }
        const gasOrders = await db.gasFeeOrder.findMany({
          where: gasWhere,
          select: {
            userId: true, pkrAmount: true, paymentAmount: true,
            user: { select: { id: true, username: true } },
          },
        })
        const map = new Map<string, { userId: string; username: string; completedTrades: number; totalVolumePKR: number }>()
        for (const o of gasOrders) {
          if (!o.userId || !o.user) continue
          const vol = Number(o.pkrAmount ?? o.paymentAmount ?? 0)
          const existing = map.get(o.userId)
          if (existing) {
            existing.completedTrades += 1
            existing.totalVolumePKR += vol
          } else {
            map.set(o.userId, { userId: o.userId, username: o.user.username, completedTrades: 1, totalVolumePKR: vol })
          }
        }
        const allRanked = [...map.values()]
          .sort((a, b) => b.completedTrades - a.completedTrades)
          .map((e, i) => ({ rank: i + 1, ...e, totalVolumePKR: e.totalVolumePKR.toFixed(2) }))
        total = allRanked.length
        entries = allRanked.slice(skip, skip + limit).map((e, i) => ({ ...e, rank: skip + i + 1 }))
      }
    } else {
      // Merchants leaderboard (unchanged)
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
        tradeType,
        entries,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })
}
