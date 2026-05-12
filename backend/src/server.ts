import './lib/env'
import { buildApp } from './app'
import { connectRedis, disconnectRedis } from './lib/redis'
import { db } from './lib/prisma'
import { logger } from './lib/logger'
import { env } from './lib/env'
import { startWorkers } from './queues/workers'

async function start() {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null

  try {
    logger.info('Starting PakSwap backend...')

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

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start()
