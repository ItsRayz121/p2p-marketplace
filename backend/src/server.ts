import 'dotenv/config'
import './lib/env'
import * as Sentry from '@sentry/node'

// Initialize Sentry before anything else so it can capture startup errors.
// No-ops when SENTRY_DSN is not set.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  enabled: !!process.env.SENTRY_DSN,
})

import { buildApp } from './app'
import { connectRedis, disconnectRedis } from './lib/redis'
import { db } from './lib/prisma'
import { logger } from './lib/logger'
import { env } from './lib/env'
import { startWorkers } from './queues/workers'
import { validateWalletCustodyAtStartup } from './lib/walletCrypto'
import { validateGasWalletAtStartup } from './lib/gas/gasWalletService'
import { reportMoralisStartupStatus } from './lib/moralisStartupCheck'
import { reportGasRpcStartupStatus } from './lib/gas/gasRpcStartupCheck'
import { validatePrismaSchemaAtStartup } from './lib/schemaValidation'
import { configurePush } from './lib/push.service'

async function start() {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null

  try {
    logger.info('Starting PakSwap backend...')

    // Validate wallet custody config before accepting traffic. Throws if the
    // master key/ciphertext are half-configured or fail to decrypt. Logs
    // configured/not without ever printing key material.
    const custody = validateWalletCustodyAtStartup()
    logger.info({ configured: custody.configured }, 'Wallet custody validated')

    const gasWallet = validateGasWalletAtStartup()
    if (gasWallet.configured) {
      logger.info(
        { tronHotWallet: gasWallet.tronHotWallet, evmHotWallet: gasWallet.evmHotWallet },
        'Gas wallet (mnemonic) configured — TRON + all EVM chains active',
      )
      // Non-EVM chain startup status (inactive chains — warnings only)
      const { sol, ton, sui } = gasWallet.nonEvm ?? {}
      if (sol && 'address' in sol) {
        logger.info({ address: sol.address }, 'SOL hot wallet address derived (chain inactive)')
        if (sol.warning) logger.warn({ warning: sol.warning }, 'SOL startup warning')
      } else if (sol && 'error' in sol) {
        logger.warn({ error: sol.error }, 'SOL startup derivation failed (chain inactive — non-fatal)')
      }
      if (ton && 'address' in ton) {
        logger.info({ address: ton.address }, 'TON hot wallet address derived (chain inactive)')
        if (ton.warning) logger.warn({ warning: ton.warning }, 'TON startup warning')
      } else if (ton && 'error' in ton) {
        logger.warn({ error: ton.error }, 'TON startup derivation failed (chain inactive — non-fatal)')
      }
      if (sui && 'address' in sui) {
        logger.info({ address: sui.address, blake2bAvailable: sui.blake2bAvailable }, 'SUI hot wallet address derived (chain inactive)')
        if (sui.warning) logger.warn({ warning: sui.warning }, 'SUI startup warning')
      } else if (sui && 'error' in sui) {
        logger.warn({ error: sui.error }, 'SUI startup derivation failed (chain inactive — non-fatal)')
      }
    } else {
      throw new Error(
        'Gas wallet mnemonic not configured: GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT must both be set. ' +
        'Legacy GAS_WALLET_PRIVATE_KEY_* fallbacks were removed in Phase 8.',
      )
    }

    // Verify the generated Prisma client has every model we rely on. Logs an
    // error (not throw) so the operator sees the gap without losing the
    // service — the missing models would show up at first user request
    // otherwise with cryptic "Cannot read properties of undefined" errors.
    validatePrismaSchemaAtStartup()

    await connectRedis()
    logger.info('Redis connected')

    await db.$connect()
    logger.info('Database connected')

    configurePush()
    app = await buildApp()
    startWorkers()
    logger.info('BullMQ workers started')

    await app.listen({ port: env.PORT, host: env.HOST })
    logger.info(`Server listening on ${env.HOST}:${env.PORT}`)
    logger.info(`Health check: http://${env.HOST}:${env.PORT}/health`)
    logger.info(`Environment: ${env.NODE_ENV}`)

    // Async, fire-and-forget — never blocks listen(). Logs an ops report
    // (which streams are configured, which respond) without throwing.
    void reportMoralisStartupStatus()
    // Log RPC config for active gas chains; warns if using public defaults.
    void reportGasRpcStartupStatus()
  } catch (err) {
    logger.error({ err }, 'Failed to start server')
    process.exit(1)
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    try {
      if (app) await app.close()
      await disconnectRedis()
      await db.$disconnect()
      logger.info('Graceful shutdown complete')
      process.exit(0)
    } catch (err) {
      logger.error({ err }, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  process.on('SIGINT', () => { void shutdown('SIGINT') })
}

void start()
