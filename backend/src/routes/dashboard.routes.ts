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
}
