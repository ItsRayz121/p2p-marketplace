import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'

type Period = 'all' | 'month' | 'week'
type TradeType = 'all' | 'usdt' | 'ctm' | 'gas'

function dateSince(period: Period): Date | undefined {
  if (period === 'week') return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  if (period === 'month') return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  return undefined
}

interface UserAccum {
  userId: string
  username: string
  completedTrades: number
  totalVolumePKR: number
}

function accumulate(map: Map<string, UserAccum>, userId: string, username: string, vol: number) {
  const e = map.get(userId)
  if (e) {
    e.completedTrades += 1
    e.totalVolumePKR += vol
  } else {
    map.set(userId, { userId, username, completedTrades: 1, totalVolumePKR: vol })
  }
}

function sortAndPage(map: Map<string, UserAccum>, skip: number, limit: number) {
  const sorted = [...map.values()].sort(
    (a, b) => b.totalVolumePKR - a.totalVolumePKR || b.completedTrades - a.completedTrades,
  )
  const total = sorted.length
  const page = sorted.slice(skip, skip + limit).map((e, i) => ({
    rank: skip + i + 1,
    userId: e.userId,
    username: e.username,
    completedTrades: e.completedTrades,
    totalVolumePKR: e.totalVolumePKR.toFixed(2),
  }))
  return { total, entries: page }
}

export async function leaderboardRoutes(app: FastifyInstance) {
  app.get('/leaderboard', async (req, reply) => {
    const query = req.query as Record<string, string>
    const type = (query.type as 'traders' | 'merchants') ?? 'traders'
    const period = (query.period as Period) ?? 'all'
    const tradeType = (query.tradeType as TradeType) ?? 'all'
    const page = query.page ? parseInt(query.page, 10) : 1
    const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
    const skip = (page - 1) * limit
    const since = dateSince(period)

    let entries: unknown[]
    let total: number

    if (type === 'traders') {
      if (tradeType === 'all') {
        // Overall: union of all three trade sources queried live.
        // TradeStats is NOT used here — it only has USDT history and would miss CTM/Gas trades.
        const [ctmTrades, usdtTrades, gasOrders] = await Promise.all([
          db.ctmTrade.findMany({
            where: {
              status: 'completed',
              ...(since ? { completedAt: { gte: since } } : {}),
            },
            select: {
              buyerId: true, sellerId: true, fiatAmount: true,
              buyer: { select: { id: true, username: true } },
              seller: { select: { id: true, username: true } },
            },
          }),
          db.trade.findMany({
            where: {
              status: 'crypto_released',
              ...(since ? { updatedAt: { gte: since } } : {}),
            },
            select: {
              buyerId: true, sellerId: true, fiatAmount: true,
              buyer: { select: { id: true, username: true } },
              seller: { select: { id: true, username: true } },
            },
          }),
          db.gasFeeOrder.findMany({
            where: {
              status: 'delivered',
              userId: { not: null },
              ...(since ? { deliveredAt: { gte: since } } : {}),
            },
            select: {
              userId: true, pkrAmount: true, paymentAmount: true,
              user: { select: { id: true, username: true } },
            },
          }),
        ])

        const map = new Map<string, UserAccum>()

        // CTM: both buyer and seller participate in each trade
        for (const t of ctmTrades) {
          const vol = Number(t.fiatAmount)
          accumulate(map, t.buyerId, t.buyer.username, vol)
          accumulate(map, t.sellerId, t.seller.username, vol)
        }

        // USDT P2P: both buyer and seller participate
        for (const t of usdtTrades) {
          const vol = Number(t.fiatAmount)
          accumulate(map, t.buyerId, t.buyer.username, vol)
          accumulate(map, t.sellerId, t.seller.username, vol)
        }

        // Gas: only the ordering user (buyer side)
        for (const o of gasOrders) {
          if (!o.userId || !o.user) continue
          accumulate(map, o.userId, o.user.username, Number(o.pkrAmount ?? 0))
        }

        const paged = sortAndPage(map, skip, limit)
        total = paged.total

        // Enrich with badge/rating from TradeStats (best-effort — may be absent for new users)
        const pageUserIds = paged.entries.map((e) => e.userId)
        const statsRows = await db.tradeStats.findMany({
          where: { userId: { in: pageUserIds } },
          select: { userId: true, badge: true, badgeLabel: true, avgRating: true, completionRate: true, trustScore: true },
        })
        const statsById = new Map(statsRows.map((s) => [s.userId, s]))

        entries = paged.entries.map((e) => {
          const s = statsById.get(e.userId)
          return {
            ...e,
            badge: s?.badge ?? null,
            badgeLabel: s?.badgeLabel ?? null,
            avgRating: s?.avgRating ?? null,
            completionRate: s?.completionRate ?? null,
            trustScore: s?.trustScore ?? null,
          }
        })
      } else if (tradeType === 'ctm') {
        const ctmTrades = await db.ctmTrade.findMany({
          where: {
            status: 'completed',
            ...(since ? { completedAt: { gte: since } } : {}),
          },
          select: {
            buyerId: true, sellerId: true, fiatAmount: true,
            buyer: { select: { id: true, username: true } },
            seller: { select: { id: true, username: true } },
          },
        })
        const map = new Map<string, UserAccum>()
        for (const t of ctmTrades) {
          const vol = Number(t.fiatAmount)
          accumulate(map, t.buyerId, t.buyer.username, vol)
          accumulate(map, t.sellerId, t.seller.username, vol)
        }
        const paged = sortAndPage(map, skip, limit)
        total = paged.total
        entries = paged.entries
      } else if (tradeType === 'usdt') {
        const usdtTrades = await db.trade.findMany({
          where: {
            status: 'crypto_released',
            ...(since ? { updatedAt: { gte: since } } : {}),
          },
          select: {
            buyerId: true, sellerId: true, fiatAmount: true,
            buyer: { select: { id: true, username: true } },
            seller: { select: { id: true, username: true } },
          },
        })
        const map = new Map<string, UserAccum>()
        for (const t of usdtTrades) {
          const vol = Number(t.fiatAmount)
          accumulate(map, t.buyerId, t.buyer.username, vol)
          accumulate(map, t.sellerId, t.seller.username, vol)
        }
        const paged = sortAndPage(map, skip, limit)
        total = paged.total
        entries = paged.entries
      } else {
        // gas
        const gasOrders = await db.gasFeeOrder.findMany({
          where: {
            status: 'delivered',
            userId: { not: null },
            ...(since ? { deliveredAt: { gte: since } } : {}),
          },
          select: {
            userId: true, pkrAmount: true, paymentAmount: true,
            user: { select: { id: true, username: true } },
          },
        })
        const map = new Map<string, UserAccum>()
        for (const o of gasOrders) {
          if (!o.userId || !o.user) continue
          accumulate(map, o.userId, o.user.username, Number(o.pkrAmount ?? 0))
        }
        const paged = sortAndPage(map, skip, limit)
        total = paged.total
        entries = paged.entries
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
      data: { type, period, tradeType, entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })
}
