import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { getRateCoin } from '../services/marketplace.service'

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/dashboard/summary
  app.get('/dashboard/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const [user, wallets, recentTrades, recentOrders, usdtRate, notifications, tradeStats, ctmCompletedTrades, gasCompletedOrders, ctmTerminalCount, gasTerminalCount] =
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

        db.wallet.findMany({ where: { userId } }),

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

        db.tradeStats.findUnique({ where: { userId } }),

        db.ctmTrade.count({
          where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'completed' },
        }),

        db.gasFeeOrder.count({
          where: { userId, status: 'delivered' },
        }),

        // CTM terminal count for cross-platform completion rate
        db.ctmTrade.count({
          where: {
            OR: [{ buyerId: userId }, { sellerId: userId }],
            status: { in: ['completed', 'cancelled', 'disputed', 'dispute_resolved', 'expired'] },
          },
        }),

        // Gas terminal count for cross-platform completion rate
        db.gasFeeOrder.count({
          where: { userId, status: { in: ['delivered', 'expired', 'failed', 'refunded'] } },
        }),
      ])

    const crossCompleted = (tradeStats?.completedTrades ?? 0) + ctmCompletedTrades + gasCompletedOrders
    const crossTotal = (tradeStats?.totalTrades ?? 0) + ctmTerminalCount + gasTerminalCount
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
}
