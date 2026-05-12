import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'

// Simple in-process TTL cache — avoids hammering DB on every Railway health poll
let cachedHealth: { result: object; status: number; cachedAt: number } | null = null
const CACHE_TTL_MS = 10_000 // 10 seconds

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    if (cachedHealth && Date.now() - cachedHealth.cachedAt < CACHE_TTL_MS) {
      return reply.status(cachedHealth.status).send(cachedHealth.result)
    }

    let dbStatus: 'ok' | 'error' = 'ok'
    let redisStatus: 'ok' | 'error' = 'ok'

    // In production: don't expose latency numbers or version strings
    let dbLatencyMs: number | undefined
    let redisLatencyMs: number | undefined

    try {
      const dbStart = Date.now()
      await db.$queryRaw`SELECT 1`
      if (env.NODE_ENV !== 'production') dbLatencyMs = Date.now() - dbStart
    } catch {
      dbStatus = 'error'
    }

    try {
      const redisStart = Date.now()
      await redis.ping()
      if (env.NODE_ENV !== 'production') redisLatencyMs = Date.now() - redisStart
    } catch {
      redisStatus = 'error'
    }

    const healthy = dbStatus === 'ok' && redisStatus === 'ok'
    const httpStatus = healthy ? 200 : 503

    const result =
      env.NODE_ENV === 'production'
        ? {
            status: healthy ? 'ok' : 'degraded',
          }
        : {
            status: healthy ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            services: {
              db: { status: dbStatus, latencyMs: dbLatencyMs },
              redis: { status: redisStatus, latencyMs: redisLatencyMs },
            },
          }

    cachedHealth = { result, status: httpStatus, cachedAt: Date.now() }
    return reply.status(httpStatus).send(result)
  })

  app.get('/health/ping', async (_req, reply) => {
    return reply.send({ pong: true })
  })
}
