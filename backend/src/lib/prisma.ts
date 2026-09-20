import { PrismaClient } from '@prisma/client'
import { env } from './env'
import { logger } from './logger'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

// Neon autosuspends its compute when idle; the first query after a suspend has to
// wait for it to wake up (sub-second to a few seconds). Prisma's own default
// connect_timeout is tighter than that margin, so without this a slow wake could
// fail a query instead of just being slow. Falls back to the raw URL if parsing
// ever fails, so a bug here can never be the reason the database is unreachable.
function withConnectTimeout(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('connect_timeout')) {
      parsed.searchParams.set('connect_timeout', '10')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: withConnectTimeout(env.DATABASE_URL) } },
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
