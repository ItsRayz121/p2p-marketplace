import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { getRateCoin } from '../services/marketplace.service'

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/dashboard/summary
  app.get('/dashboard/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const [user, wallets, recentTrades, recentOrders, usdtRate, notifications, tradeStats, ctmCompletedTrades, gasCompletedOrders] =
      await Promise.all([
        db.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            fullName: true,
            username: true,
            kycStatus: true,
            kycLevel: true,
            dailyBuyUsed: true,
            dailyBuyLimit: true,
            role: true,
          },
        }),

        db.wallet.findMany({ where: { userId } }).then((rows) =>
          rows.map((w) => ({
            coin: w.coin,
            network: w.network,
            available: (Number(w.balance) - Number(w.lockedBalance)).toFixed(8),
            locked: w.lockedBalance.toString(),
            total: w.balance.toString(),
          }))
        ),

        db.trade.findMany({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            buyer: { select: { username: true } },
            seller: { select: { username: true } },
          },
        }),

        // InstantBuyOrder — try/catch in case model isn't migrated yet
        (async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await (db as any).instantBuyOrder.findMany({
              where: { userId },
              take: 3,
              orderBy: { createdAt: 'desc' },
            })
          } catch {
            return []
          }
        })(),

        getRateCoin('USDT').catch(() => null),

        db.notification.findMany({
          where: { userId, isRead: false },
          take: 5,
          orderBy: { createdAt: 'desc' },
        }),

        // TradeStats is now the single source of truth: includes USDT + CTM + Gas
        db.tradeStats.findUnique({ where: { userId } }),

        // Kept separately for the breakdown display (how many trades per marketplace)
        db.ctmTrade.count({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'completed' },
        }),

        db.gasFeeOrder.count({
          where: { userId, status: 'delivered' },
        }),
      ])

    // TradeStats now covers all three marketplaces, so no cross-add needed
    const crossTotal = tradeStats?.totalTrades ?? 0
    const crossCompleted = tradeStats?.completedTrades ?? 0
    const crossPlatformCompletionRate = crossTotal > 0 ? crossCompleted / crossTotal : null

    return reply.send({
      success: true,
      data: {
        user,
        wallets,
        recentTrades,
        recentOrders,
        usdtRate,
        notifications,
        tradeStats,
        ctmCompletedTrades,
        gasCompletedOrders,
        crossPlatformCompletionRate,
      },
    })
  })

  // GET /api/dashboard/trading-analytics
  // Combined trading history across all three marketplaces: USDT P2P, CTM, and Gas.
  app.get('/dashboard/trading-analytics', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const [
      usdtTotal, usdtCompleted, usdtVolume,
      ctmTotal, ctmCompleted, ctmVolume,
      gasTotal, gasDelivered, gasSpend,
      ctmProfile,
    ] = await Promise.all([
      db.trade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] } }),
      db.trade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'crypto_released' } }),
      db.trade.aggregate({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'crypto_released' },
        _sum: { fiatAmount: true },
      }),

      db.ctmTrade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] } }),
      db.ctmTrade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'completed' } }),
      db.ctmTrade.aggregate({
        where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'completed' },
        _sum: { fiatAmount: true },
      }),

      db.gasFeeOrder.count({ where: { userId } }),
      db.gasFeeOrder.count({ where: { userId, status: 'delivered' } }),
      db.gasFeeOrder.aggregate({
        where: { userId, status: 'delivered' },
        _sum: { gasAmountUSD: true },
      }),

      db.ctmMerchantProfile.findUnique({
        where: { userId },
        select: { tier: true, ctmAvgRating: true, isActive: true },
      }),
    ])

    const usdtVolumePkr = Number(usdtVolume._sum?.fiatAmount ?? 0)
    const ctmVolumePkr = Number(ctmVolume._sum?.fiatAmount ?? 0)

    const totalTrades = usdtTotal + ctmTotal + gasTotal
    const totalCompleted = usdtCompleted + ctmCompleted + gasDelivered

    return reply.send({
      success: true,
      data: {
        combined: {
          totalTrades,
          completedTrades: totalCompleted,
          completionRate: totalTrades > 0 ? totalCompleted / totalTrades : null,
          totalVolumePkr: (usdtVolumePkr + ctmVolumePkr).toFixed(2),
        },
        usdt: {
          totalTrades: usdtTotal,
          completedTrades: usdtCompleted,
          volumePkr: usdtVolumePkr.toFixed(2),
        },
        ctm: {
          totalTrades: ctmTotal,
          completedTrades: ctmCompleted,
          volumePkr: ctmVolumePkr.toFixed(2),
          tier: ctmProfile?.tier ?? null,
          avgRating: ctmProfile?.ctmAvgRating ? Number(ctmProfile.ctmAvgRating).toFixed(2) : null,
          isMerchant: !!ctmProfile,
        },
        gas: {
          totalOrders: gasTotal,
          deliveredOrders: gasDelivered,
          spentUsd: Number(gasSpend._sum?.gasAmountUSD ?? 0).toFixed(2),
        },
      },
    })
  })
}
