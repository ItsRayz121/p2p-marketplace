import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.routes'

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes)

  // Routes are registered here as features are built.
  // Follow the order in FULL_SPEC.md Section 28 backend structure.
  //
  // await app.register(authRoutes, { prefix: '/api/auth' })
  // await app.register(userRoutes, { prefix: '/api/users' })
  // await app.register(adRoutes, { prefix: '/api/ads' })
  // await app.register(tradeRoutes, { prefix: '/api/trades' })
  // await app.register(walletRoutes, { prefix: '/api/wallet' })
  // await app.register(instantBuyRoutes, { prefix: '/api/instant-buy' })
  // await app.register(kycRoutes, { prefix: '/api/kyc' })
  // await app.register(disputeRoutes, { prefix: '/api/disputes' })
  // await app.register(merchantRoutes, { prefix: '/api/merchants' })
  // await app.register(notificationRoutes, { prefix: '/api/notifications' })
  // await app.register(referralRoutes, { prefix: '/api/referral' })
  // await app.register(rateAlertRoutes, { prefix: '/api/rate-alerts' })
  // await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' })
  // await app.register(uploadRoutes, { prefix: '/api/upload' })
  // await app.register(webhookRoutes, { prefix: '/api/webhooks' })
  // await app.register(gasFeeRoutes, { prefix: '/api/gas-fee' })
  // await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
  // await app.register(adminRoutes, { prefix: '/api/admin' })
}
