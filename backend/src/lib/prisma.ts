import { PrismaClient } from '@prisma/client'
import { env } from './env'
import { logger } from './logger'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'error', 'warn']
        : ['error'],
  })

// Always cache globally — prevents connection pool exhaustion in both dev hot-reload AND production
globalForPrisma.prisma = db

if (env.NODE_ENV === 'development') {
  db.$on('query' as never, (e: { query: string; duration: number }) => {
    if (e.duration > 100) {
      logger.warn({ query: e.query, duration: e.duration }, 'Slow query detected')
    }
  })
}
