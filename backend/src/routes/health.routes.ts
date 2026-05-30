import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { EMAIL_FROM, isEmailConfigured } from '../lib/resend'

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

  // GET /health/email — Resend sender diagnostic.
  // Reports whether outbound email will work and lists the last 10 attempts
  // from the email log. Safe to expose: no secrets, no PII beyond toEmail which
  // the operator already has access to via Resend's dashboard.
  app.get('/health/email', async (_req, reply) => {
    const recentLogs = await db.emailLog
      .findMany({
        orderBy: { sentAt: 'desc' },
        take: 10,
        select: { template: true, toEmail: true, status: true, sentAt: true },
      })
      .catch(() => [] as Array<{ template: string; toEmail: string; status: string; sentAt: Date }>)

    return reply.send({
      configured: isEmailConfigured(),
      emailFromConfigured: EMAIL_FROM,
      emailFromRaw: env.EMAIL_FROM ?? null,
      resendApiKeySet: Boolean(env.RESEND_API_KEY),
      adminAlertEmail: env.ADMIN_ALERT_EMAIL ?? null,
      recent: recentLogs,
      hint: !isEmailConfigured()
        ? 'Set EMAIL_FROM in Railway to a Resend-verified sender (e.g. "RupChain <noreply@yourdomain.com>") and ensure RESEND_API_KEY is set, then redeploy.'
        : 'Configuration looks valid. If sends still fail, check that the sender domain is verified in your Resend dashboard.',
    })
  })
}
