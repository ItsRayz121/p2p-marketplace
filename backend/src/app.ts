import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import { Prisma } from '@prisma/client'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { rateLimitRedis } from './lib/redis'
import { registerRoutes } from './routes/index'
import { AppError } from './lib/errors'
import { csrfHook } from './lib/csrf'

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
  })

  // Cookies (for httpOnly refresh token)
  await app.register(cookie, {
    secret: env.CSRF_SECRET,
  })

  // Global rate limiting — per-route limits are set in route files
  await app.register(rateLimit, {
    redis: rateLimitRedis,
    skipOnError: true, // fail open if Redis is unavailable — never block a request with 500
    global: true,
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: `Rate limit exceeded. Retry after ${context.after}.`,
      retryAfter: context.ttl,
    }),
  })

  // CSRF protection — validates X-CSRF-Token on all unsafe methods
  app.addHook('onRequest', csrfHook)

  // Request logging + propagate requestId to response
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id)
    logger.info({
      requestId: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
    }, 'Incoming request')
  })

  // Catch-all hook — fires for every error regardless of which error handler runs.
  // Use console.error so it always appears in Railway stdout even if pino is broken.
  app.addHook('onError', async (_req, _reply, error) => {
    console.error('[onError hook]', {
      name: error?.constructor?.name,
      message: (error as Error)?.message,
      stack: (error as Error)?.stack?.split('\n').slice(0, 6).join('\n'),
    })
  })

  // Global error handler
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: error.code,
        message: error.message,
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
