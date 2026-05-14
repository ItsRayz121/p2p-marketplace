import type { FastifyInstance } from 'fastify'
import { healthRoutes } from './health.routes'
import { authRoutes } from './auth.routes'
import { marketplaceRoutes } from './marketplace.routes'
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
import { merchantGasRoutes } from './merchantGas.routes'
import { adminRoutes } from './admin.routes'

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes)
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.register(marketplaceRoutes, { prefix: '/api/v1/marketplace' })
  await app.register(adRoutes, { prefix: '/api/v1' })
  await app.register(tradeRoutes, { prefix: '/api/v1' })
  await app.register(walletRoutes, { prefix: '/api/v1' })
  await app.register(kycRoutes, { prefix: '/api/v1' })
  await app.register(userRoutes, { prefix: '/api/v1' })
  await app.register(dashboardRoutes, { prefix: '/api/v1' })
  await app.register(merchantRoutes, { prefix: '/api/v1' })
  await app.register(instantBuyRoutes, { prefix: '/api/v1' })
  await app.register(disputeRoutes, { prefix: '/api/v1' })
  await app.register(notificationRoutes, { prefix: '/api/v1' })
  await app.register(referralRoutes, { prefix: '/api/v1' })
  await app.register(leaderboardRoutes, { prefix: '/api/v1' })
  await app.register(uploadRoutes, { prefix: '/api/v1' })
  await app.register(webhookRoutes, { prefix: '/api/v1' })
  await app.register(rateAlertRoutes, { prefix: '/api/v1' })
  await app.register(gasFeeRoutes, { prefix: '/api/v1' })
  await app.register(merchantGasRoutes, { prefix: '/api/v1' })
  await app.register(adminRoutes, { prefix: '/api/v1' })
}
