import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { getRateCoin } from '../services/marketplace.service'

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /api/dashboard/summary
  app.get('/dashboard/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const [user, wallets, recentTrades, recentOrders, usdtRate, notifications, tradeStats] =
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
      ])

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
      },
    })
  })
}
