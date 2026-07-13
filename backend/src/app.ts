import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import * as Sentry from '@sentry/node'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { rateLimitRedis } from './lib/redis'
import { registerRoutes } from './routes/index'
import { AppError } from './lib/errors'
import { csrfHook } from './lib/csrf'
import { requestContext, resolveClientIp } from './lib/requestContext'
import { verifyAccessToken } from './lib/jwt'

export async function buildApp() {
  const app = Fastify({
    logger: false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
  })

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://*.amazonaws.com'],
        connectSrc: ["'self'", env.FRONTEND_URL],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })

  // CORS — only allows frontend origin
  await app.register(cors, {
    origin: [env.FRONTEND_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Every API call carries an `Authorization: Bearer` header, which is NOT a
    // CORS-safelisted request header — so the browser fires a preflight OPTIONS
    // before EVERY request, including plain GETs. Without Access-Control-Max-Age
    // the preflight result is cached for ~5s (Chrome's default), so a page that
    // makes 6 reads pays for 12 round trips. On a slow/lossy mobile link (our
    // audience: 4G + CGNAT) that doubles both the latency and the number of
    // chances to hit a dead connection and fail with "Failed to fetch".
    // Caching the preflight halves the request count. Browsers clamp this to
    // their own ceiling (Chrome 2h, Firefox 24h) — asking for 24h just means
    // "as long as you'll allow".
    maxAge: 86400,
    // Without this, the browser hides these from fetch() (they are not CORS-safelisted).
    // The client reads Retry-After to show an accurate "retry after Ns" countdown on a
    // 429 (otherwise it degrades to a bare "Please wait before retrying."), and
    // X-Request-Id to surface a support reference on 500s.
    exposedHeaders: [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-Id',
    ],
  })

  // Cookies (for httpOnly refresh token)
  await app.register(cookie, {
    secret: env.CSRF_SECRET,
  })

  // Multipart — required for file uploads (payment proof, token proof)
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

  // Global rate limiting — per-route limits are set in route files.
  //
  // Two INDEPENDENT per-IP buckets, split by method class:
  //   • reads  (GET/HEAD/OPTIONS) — the 15–60s pollers on listing/trade/dashboard
  //     pages, SSE reconnects, and the fan-out of reads on every page load. These
  //     are cheap and idempotent, and a single active user (especially with a few
  //     tabs open) racks them up fast.
  //   • writes (POST/PUT/PATCH/DELETE) — the actual actions: creating a trade,
  //     placing a bid, sending a chat message.
  //
  // Keying the bucket by method class isolates the two so background reads can
  // NEVER exhaust the budget a user needs for a real action and surface
  // "Too many requests" mid-flow (the failure mode this split fixes). Sensitive
  // routes keep their own much tighter per-route limits (auth, SSE, etc.).
  //
  // The bucket is keyed by the AUTHENTICATED USER when a valid access token is
  // present, and only falls back to IP for anonymous traffic. This is the load-
  // bearing part for our audience: Pakistani mobile carriers and most ISPs sit
  // behind CGNAT, so hundreds of distinct users (plus a single user's own tabs /
  // devices / Telegram Mini App) egress through a handful of shared public IPs.
  // Keying purely by IP lumped them all into one budget, so a few active users
  // would saturate it and unrelated logged-in users hit "Too many requests" on a
  // real action (e.g. confirming CTM trade details). The access token is a
  // stateless HMAC JWT, so verifying it here is cheap (no DB / IO) and works even
  // though this runs in onRequest, before the route's auth preHandler.
  const isReadMethod = (method: string) =>
    method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  await app.register(rateLimit, {
    redis: rateLimitRedis,
    skipOnError: true, // fail open if Redis is unavailable — never block a request with 500
    global: true,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const cls = isReadMethod(req.method) ? 'r' : 'w'
      const auth = req.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        const payload = verifyAccessToken(auth.slice(7))
        if (payload) return `u:${payload.userId}:${cls}`
      }
      const ip = resolveClientIp(req.headers as Record<string, unknown>, req.ip) ?? req.ip
      return `ip:${ip}:${cls}`
    },
    max: (req) => (isReadMethod(req.method) ? 1000 : 200),
    errorResponseBuilder: (_req, context) => ({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded. Retry after ${context.after}.`,
      retryAfter: context.ttl,
    }),
  })

  // CSRF protection — validates X-CSRF-Token on all unsafe methods
  app.addHook('onRequest', csrfHook)

  // Request logging + propagate requestId to response + seed request context
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id)
    // Seed AsyncLocalStorage so audit writes deep in the service layer can
    // attribute the caller's IP / user-agent without threading params.
    const ua = req.headers['user-agent']
    requestContext.enterWith({
      ip: resolveClientIp(req.headers as Record<string, unknown>, req.ip),
      userAgent: typeof ua === 'string' ? ua : undefined,
    })
    logger.info({
      requestId: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
    }, 'Incoming request')
  })

  // Catch-all hook — fires for every error regardless of which error handler runs.
  // Global error handler
  app.setErrorHandler((error, _req, reply) => {
    // AppError must be checked FIRST — it has a statusCode property that would
    // otherwise be caught by the generic httpStatus >= 400 fallback below,
    // causing the specific error.code (e.g. EMAIL_NOT_VERIFIED) to be lost.
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: error.code,
        message: error.message,
      })
    }

    // Zod validation error (schema.parse in routes without a local handler,
    // e.g. the telegram routes). Surface a 400 with the field details instead
    // of falling through to the generic 500 below.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      })
    }

    // Fastify validation error
    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.validation,
      })
    }

    // @fastify/rate-limit and FastifyError (body parsing) carry statusCode but are not
    // AppError instances — handle them here as a fallback after all instanceof checks.
    const httpStatus = (error as { statusCode?: number }).statusCode
    if (httpStatus === 429) {
      return reply.status(429).send({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: (error as { message?: string }).message ?? 'Too many requests. Please wait before retrying.',
      })
    }
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return reply.status(httpStatus).send({
        success: false,
        error: 'REQUEST_ERROR',
        message: (error as { message?: string }).message ?? 'Invalid request',
      })
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return reply.status(404).send({ success: false, error: 'NOT_FOUND', message: 'Record not found' })
      }
      if (error.code === 'P2002') {
        return reply.status(409).send({ success: false, error: 'CONFLICT', message: 'A record with this data already exists' })
      }
      logger.error({ err: error, prismaCode: error.code }, 'Prisma error')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }

    if (
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientRustPanicError
    ) {
      logger.error({ err: error }, 'Database connection error')
      return reply.status(503).send({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable' })
    }

    if (error instanceof Prisma.PrismaClientValidationError) {
      logger.error({ err: error, message: error.message }, 'Prisma validation error — likely schema/query mismatch')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      logger.error({ err: error, message: error.message }, 'Prisma unknown request error')
      return reply.status(500).send({ success: false, error: 'DATABASE_ERROR', message: 'A database error occurred' })
    }

    logger.error({ err: error, message: error.message, stack: error.stack }, 'Unhandled error')
    Sentry.captureException(error)

    return reply.status(500).send({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    })
  })

  // 404 handler
  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      success: false,
      error: 'NOT_FOUND',
      message: 'Route not found',
    })
  })

  // Register all routes
  await registerRoutes(app)

  return app
}
