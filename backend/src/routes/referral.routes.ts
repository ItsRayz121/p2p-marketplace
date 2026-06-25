import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { Errors } from '../lib/errors'

export async function referralRoutes(app: FastifyInstance) {
  // GET /api/referral
  app.get('/referral', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    })
    if (!user) throw Errors.NOT_FOUND('User')

    const [referralCount, totalEarnedResult, rewards, referredUsers] = await Promise.all([
      db.user.count({ where: { referredById: userId } }),
      db.referralReward.aggregate({
        where: { referrerId: userId, status: 'paid' },
        _sum: { rewardAmount: true },
      }),
      db.referralReward.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          referred: { select: { username: true, createdAt: true } },
        },
      }),
      db.user.findMany({
        where: { referredById: userId },
        select: {
          id: true,
          username: true,
          createdAt: true,
          kycStatus: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ])

    const responseData = {
      referralCode: user.referralCode,
      referralCount,
      totalEarned: totalEarnedResult._sum.rewardAmount ?? 0,
      rewards,
      referredUsers,
    }

    return reply.send({ success: true, data: responseData })
  })

  // GET /api/referral/stats — alias for frontend dashboard
  app.get('/referral/stats', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const user = await db.user.findUnique({ where: { id: userId }, select: { referralCode: true } })
    if (!user) throw Errors.NOT_FOUND('User')

    const [totalReferrals, totalEarnedResult, pendingResult] = await Promise.all([
      db.user.count({ where: { referredById: userId } }),
      db.referralReward.aggregate({
        where: { referrerId: userId, status: 'paid' },
        _sum: { rewardAmount: true },
      }),
      db.referralReward.aggregate({
        where: { referrerId: userId, status: 'pending' },
        _sum: { rewardAmount: true },
      }),
    ])

    return reply.send({
      success: true,
      data: {
        referralCode: user.referralCode,
        totalReferrals,
        totalEarned: totalEarnedResult._sum.rewardAmount ?? 0,
        pendingEarnings: pendingResult._sum.rewardAmount ?? 0,
      },
    })
  })

  // GET /api/referral/list — alias for frontend referral list
  app.get('/referral/list', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id

    const referredUsers = await db.user.findMany({
      where: { referredById: userId },
      select: { id: true, username: true, createdAt: true, tradeStats: { select: { completedTrades: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    // Map to the shape the frontend list expects ({ joinedAt, status }). A referral is
    // "active" once they've completed at least one trade, else "not traded yet".
    const referrals = referredUsers.map((u) => ({
      id: u.id,
      username: u.username,
      joinedAt: u.createdAt,
      status: (u.tradeStats?.completedTrades ?? 0) > 0 ? 'active' : 'pending',
    }))

    return reply.send({ success: true, data: { referrals } })
  })
}
