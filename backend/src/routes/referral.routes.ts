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

    return reply.send({
      success: true,
      data: {
        referralCode: user.referralCode,
        referralCount,
        totalEarned: totalEarnedResult._sum.rewardAmount ?? 0,
        rewards,
        referredUsers,
      },
    })
  })
}
