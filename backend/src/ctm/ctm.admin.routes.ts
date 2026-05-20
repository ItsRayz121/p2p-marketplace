import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'

export async function ctmAdminRoutes(app: FastifyInstance) {
  // GET /ctm/admin/stats — aggregate dashboard stats
  app.get('/ctm/admin/stats', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (_req, reply) => {
    const [
      totalTrades,
      completedTrades,
      activeTrades,
      disputedTrades,
      expiredTrades,
      activeListings,
      totalMerchants,
      pendingMerchants,
      totalVolume,
      merchantsByTier,
      topTokens,
      openDisputes,
    ] = await Promise.all([
      db.ctmTrade.count(),
      db.ctmTrade.count({ where: { status: 'completed' } }),
      db.ctmTrade.count({ where: { status: { in: ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted'] } } }),
      db.ctmTrade.count({ where: { status: { in: ['disputed', 'dispute_resolved'] } } }),
      db.ctmTrade.count({ where: { status: 'expired' } }),
      db.ctmListing.count({ where: { status: 'active' } }),
      db.ctmMerchantProfile.count({ where: { isActive: true } }),
      db.ctmMerchantProfile.count({ where: { approvedAt: null } }),
      db.ctmTrade.aggregate({ _sum: { fiatAmount: true }, where: { status: 'completed' } }),
      db.ctmMerchantProfile.groupBy({ by: ['tier'], _count: { id: true }, where: { isActive: true } }),
      db.ctmToken.findMany({
        where: { status: 'approved' },
        orderBy: { totalTrades: 'desc' },
        take: 5,
        select: { id: true, name: true, symbol: true, logoUrl: true, totalTrades: true, totalVolumePkr: true },
      }),
      db.ctmDispute.count({ where: { status: 'open' } }),
    ])

    const tierMap: Record<string, number> = {}
    for (const row of merchantsByTier) tierMap[row.tier] = row._count.id

    return reply.send({
      success: true,
      data: {
        trades: {
          total: totalTrades,
          completed: completedTrades,
          active: activeTrades,
          disputed: disputedTrades,
          expired: expiredTrades,
        },
        listings: { active: activeListings },
        merchants: { active: totalMerchants, pendingApproval: pendingMerchants, byTier: tierMap },
        totalVolumePkr: totalVolume._sum.fiatAmount ?? 0,
        openDisputes,
        topTokens,
      },
    })
  })

  // GET /ctm/admin/escrow — trades with pending escrow deposits
  app.get('/ctm/admin/escrow', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page = q.page ? parseInt(q.page, 10) : 1
    const limit = q.limit ? parseInt(q.limit, 10) : 20
    const skip = (page - 1) * limit

    const [trades, total] = await Promise.all([
      db.ctmTrade.findMany({
        where: { escrowAddress: { not: null }, escrowConfirmedAt: null, status: 'awaiting_payment' },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: {
          buyer: { select: { id: true, username: true } },
          seller: { select: { id: true, username: true } },
          token: { select: { id: true, name: true, symbol: true } },
        },
      }),
      db.ctmTrade.count({ where: { escrowAddress: { not: null }, escrowConfirmedAt: null, status: 'awaiting_payment' } }),
    ])

    return reply.send({ success: true, data: { trades, total, page, limit } })
  })
}
