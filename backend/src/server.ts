import 'dotenv/config'
import './lib/env'
import { buildApp } from './app'
import { connectRedis, disconnectRedis } from './lib/redis'
import { db } from './lib/prisma'
import { logger } from './lib/logger'
import { env } from './lib/env'
import { startWorkers } from './queues/workers'
import { validateWalletCustodyAtStartup } from './lib/walletCrypto'
import { reportMoralisStartupStatus } from './lib/moralisStartupCheck'
import { validatePrismaSchemaAtStartup } from './lib/schemaValidation'

async function start() {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null

  try {
    logger.info('Starting PakSwap backend...')

    // Validate wallet custody config before accepting traffic. Throws if the
    // master key/ciphertext are half-configured or fail to decrypt. Logs
    // configured/not without ever printing key material.
    const custody = validateWalletCustodyAtStartup()
    logger.info({ configured: custody.configured }, 'Wallet custody validated')

    // Verify the generated Prisma client has every model we rely on. Logs an
    // error (not throw) so the operator sees the gap without losing the
    // service — the missing models would show up at first user request
    // otherwise with cryptic "Cannot read properties of undefined" errors.
    validatePrismaSchemaAtStartup()

    await connectRedis()
    logger.info('Redis connected')

    await db.$connect()
    logger.info('Database connected')

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
