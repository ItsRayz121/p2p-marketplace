import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { redis } from './lib/redis'
import { registerRoutes } from './routes/index'
import { AppError } from './lib/errors'
import { csrfHook, generateCsrfToken } from './lib/csrf'

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
    redis,
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

  // CSRF token endpoint — fetch before any mutating request
  app.get('/api/v1/auth/csrf', async (_req, reply) => {
    return reply.send({ token: generateCsrfToken() })
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

    logger.error({ err: error }, 'Unhandled error')

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
