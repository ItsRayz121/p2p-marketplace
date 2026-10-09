import type { FastifyInstance } from 'fastify'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { EMAIL_FROM, isEmailConfigured } from '../lib/resend'

// Simple in-process TTL cache — avoids hammering DB on every Railway health poll
let cachedHealth: { result: object; status: number; cachedAt: number } | null = null
const CACHE_TTL_MS = 10_000 // 10 seconds

const READY_TTL_MS = 2_000
const READY_QUERY_TIMEOUT_MS = 4_000
let readyCache: { ready: boolean; at: number } | null = null
let readyInFlight: Promise<{ ready: boolean }> | null = null
// The DB query itself. A query that outlived its timeout is still holding a pool
// connection, so later checks wait on it instead of stacking up more hung queries.
// A probe that has been stuck longer than DB_PROBE_MAX_AGE_MS is given up on, so a
// query that never settles cannot keep readiness at "not ready" after the DB is back.
const DB_PROBE_MAX_AGE_MS = 30_000
let dbProbe: { q: Promise<unknown>; startedAt: number } | null = null

// Deadline for each dependency check in GET /health (also Railway's healthcheck).
const HEALTH_CHECK_TIMEOUT_MS = 5_000

/** Reject after `ms` if `p` has not settled; the timer never outlives the race. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** Bounded DB round-trip; concurrent callers share one query. Exported for tests. */
export function checkReadiness(): Promise<{ ready: boolean }> {
  if (readyCache && Date.now() - readyCache.at < READY_TTL_MS) return Promise.resolve({ ready: readyCache.ready })
  if (readyInFlight) return readyInFlight
  readyInFlight = (async () => {
    let ready = false
    try {
      if (!dbProbe || Date.now() - dbProbe.startedAt > DB_PROBE_MAX_AGE_MS) {
        // Promise.resolve: a PrismaPromise is lazy; this runs it exactly once.
        const q: Promise<unknown> = Promise.resolve(db.$queryRaw`SELECT 1`)
        const probe = { q, startedAt: Date.now() }
        dbProbe = probe
        const clear = () => { if (dbProbe === probe) dbProbe = null }
        q.then(clear, clear)
      }
      await withDeadline(dbProbe.q, READY_QUERY_TIMEOUT_MS, 'readiness')
      ready = true
    } catch {
      ready = false
    }
    readyCache = { ready, at: Date.now() }
    return { ready }
  })().finally(() => { readyInFlight = null })
  return readyInFlight
}

/** Test hook: forget the shared readiness result. */
export function resetReadinessCache(): void { readyCache = null; readyInFlight = null; dbProbe = null; cachedHealth = null }

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

    // Both checks are bounded: a stuck database or Redis makes this answer 503 in
    // seconds instead of hanging. The DB part shares the readiness probe, so a hung
    // query is never stacked on.
    {
      const dbStart = Date.now()
      if ((await checkReadiness()).ready) {
        if (env.NODE_ENV !== 'production') dbLatencyMs = Date.now() - dbStart
      } else {
        dbStatus = 'error'
      }
    }

    try {
      const redisStart = Date.now()
      await withDeadline(Promise.resolve(redis.ping()), HEALTH_CHECK_TIMEOUT_MS, 'redis')
      if (env.NODE_ENV !== 'production') redisLatencyMs = Date.now() - redisStart
    } catch {
      redisStatus = 'error'
    }

    const healthy = dbStatus === 'ok' && redisStatus === 'ok'
    const httpStatus = healthy ? 200 : 503

    // Short deployed-commit SHA so we can confirm WHICH build is live (Railway
    // injects RAILWAY_GIT_COMMIT_SHA). A 7-char SHA is not sensitive and ends the
    // "is my deploy live yet?" guessing during incident response.
    const version =
      (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown'

    const result =
      env.NODE_ENV === 'production'
        ? {
            status: healthy ? 'ok' : 'degraded',
            version,
          }
        : {
            status: healthy ? 'ok' : 'degraded',
            version,
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

  // Liveness only: proves this process answers. It touches no DB, so it must NOT be
  // read as "the app's data is reachable again" — use /health/ready for that.
  app.get('/health/ping', async (_req, reply) => {
    return reply.send({ pong: true })
  })

  // GET /health/ready — readiness for database-backed features. The client's
  // recovery checks (connection banner, offline page) use this before declaring
  // the app usable again. One bounded SELECT 1, its result shared for a couple of
  // seconds so many recovering clients cost the database one query.
  app.get('/health/ready', async (_req, reply) => {
    const { ready } = await checkReadiness()
    reply.header('Cache-Control', 'no-store')
    return ready
      ? reply.send({ success: true, ready: true })
      : reply.status(503).send({ success: false, ready: false, error: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable' })
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
