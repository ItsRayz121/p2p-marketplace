import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/node'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { rateLimitRedis } from './lib/redis'
import { registerRoutes } from './routes/index'
import { AppError } from './lib/errors'
import { csrfHook } from './lib/csrf'
import { requestContext, resolveClientIp } from './lib/requestContext'

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

  // Multipart — required for file uploads (payment proof, token proof)
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

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
