import type { FastifyInstance } from 'fastify'
import { verifyAccessToken } from '../lib/jwt'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { sseRegister, sseUnregister } from '../lib/sse'

export async function sseRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/sse?token=<accessToken>
   *
   * Long-lived SSE stream for the authenticated user.
   * Token passed as query param because EventSource does not support headers.
   * Events are JSON-encoded and pushed by sseEmit() from any service.
   *
   * Frame format:
   *   data: {"type":"notification","payload":{...}}\n\n
   *   data: {"type":"trade_update","payload":{...}}\n\n
   *   data: {"type":"ping"}\n\n         (every 25 s keepalive)
   */
  app.get('/sse', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.query as { token?: string }
    if (!token) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)

    const payload = verifyAccessToken(token)
    if (!payload) throw new AppError('UNAUTHORIZED', 'Invalid or expired token', 401)

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, isBanned: true, isSuspended: true },
    })
    if (!user) throw new AppError('UNAUTHORIZED', 'User not found', 401)
    if (user.isBanned) throw new AppError('ACCOUNT_BANNED', 'Account banned', 403)
    if (user.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Account suspended', 403)

    const userId = user.id
    const raw = reply.raw

    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache')
    raw.setHeader('Connection', 'keep-alive')
    raw.setHeader('X-Accel-Buffering', 'no')
    raw.flushHeaders()

    const clientId = sseRegister(userId, raw)

    // Keepalive ping every 25 s so proxies don't close idle connections
    const ping = setInterval(() => {
      try {
        raw.write('data: {"type":"ping"}\n\n')
      } catch {
        clearInterval(ping)
      }
    }, 25_000)

    req.socket.on('close', () => {
      clearInterval(ping)
      sseUnregister(clientId)
    })

    req.socket.on('error', () => {
      clearInterval(ping)
      sseUnregister(clientId)
    })

    // Fastify must not finalize the reply — we own the socket now
    await new Promise<void>((resolve) => {
      raw.on('close', resolve)
      raw.on('error', resolve)
    })
  })
}
