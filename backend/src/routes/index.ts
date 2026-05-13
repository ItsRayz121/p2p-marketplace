import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.routes'
import { authRoutes } from './auth.routes'
import { adRoutes } from './ad.routes'
import { tradeRoutes } from './trade.routes'
import { walletRoutes } from './wallet.routes'
import { kycRoutes } from './kyc.routes'
import { userRoutes } from './user.routes'
import { dashboardRoutes } from './dashboard.routes'
import { merchantRoutes } from './merchant.routes'
import { instantBuyRoutes } from './instantBuy.routes'
import { disputeRoutes } from './dispute.routes'
import { notificationRoutes } from './notification.routes'
import { referralRoutes } from './referral.routes'
import { leaderboardRoutes } from './leaderboard.routes'
import { uploadRoutes } from './upload.routes'
import { webhookRoutes } from './webhook.routes'
import { rateAlertRoutes } from './rateAlert.routes'
import { gasFeeRoutes } from './gasFee.routes'
import { adminRoutes } from './admin.routes'

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(adRoutes, { prefix: '/api' })
  await app.register(tradeRoutes, { prefix: '/api' })
  await app.register(walletRoutes, { prefix: '/api' })
  await app.register(kycRoutes, { prefix: '/api' })
  await app.register(userRoutes, { prefix: '/api' })
  await app.register(dashboardRoutes, { prefix: '/api' })
  await app.register(merchantRoutes, { prefix: '/api' })
  await app.register(instantBuyRoutes, { prefix: '/api' })
  await app.register(disputeRoutes, { prefix: '/api' })
  await app.register(notificationRoutes, { prefix: '/api' })
  await app.register(referralRoutes, { prefix: '/api' })
  await app.register(leaderboardRoutes, { prefix: '/api' })
  await app.register(uploadRoutes, { prefix: '/api' })
  await app.register(webhookRoutes, { prefix: '/api' })
  await app.register(rateAlertRoutes, { prefix: '/api' })
  await app.register(gasFeeRoutes, { prefix: '/api' })
  await app.register(adminRoutes, { prefix: '/api' })
}
