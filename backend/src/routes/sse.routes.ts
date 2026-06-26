import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { verifyAccessToken } from '../lib/jwt'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { sseRegister, sseUnregister } from '../lib/sse'
import { authenticate } from '../middleware/auth.middleware'

const SSE_TICKET_TTL_SECONDS = 60

export async function sseRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/sse/ticket
   *
   * Mint a single-use, 60-second ticket for opening the SSE stream. The browser
   * then connects with ?ticket=<t> instead of putting the long-lived JWT in the
   * URL (which leaks into proxy/CDN/server logs, history, Referer). Requires a
   * normal authenticated request (Authorization header), so the ticket is bound
   * to the caller's user id.
   */
  app.post(
    '/sse/ticket',
    // Keyed per-user (see the global keyGenerator). A single user legitimately
    // mints several tickets a minute — one per open tab, plus a fresh one on every
    // reconnect after the long-lived stream is cut (mobile networks / proxy idle
    // timeouts drop SSE often). Too tight a cap here turns a transient drop into a
    // self-sustaining reconnect loop, so keep real headroom.
    { preHandler: [authenticate], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const userId = req.user!.id
      const ticket = randomBytes(24).toString('hex')
      await redis.set(`sse:ticket:${ticket}`, userId, 'EX', SSE_TICKET_TTL_SECONDS)
      return reply.send({ success: true, data: { ticket, expiresIn: SSE_TICKET_TTL_SECONDS } })
    },
  )

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
  // Keyed by IP, not user: EventSource cannot send an Authorization header (the
  // ticket exists for exactly this reason), so the global keyGenerator falls back
  // to IP here. Each open tab holds its own EventSource and reopens on every
  // network drop, so 10/min was easily exhausted by a multi-tab user (or several
  // testers behind one CGNAT IP) and the resulting churn kept the connection
  // broken. Connection rate is already gated per-user by /sse/ticket above; this
  // is just a coarse backstop, so 60/min gives real headroom.
  app.get('/sse', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token, ticket } = req.query as { token?: string; ticket?: string }

    // Preferred path: single-use ticket (no JWT in the URL). Consume it atomically
    // so a leaked ticket can't be replayed.
    let resolvedUserId: string | null = null
    if (ticket) {
      const key = `sse:ticket:${ticket}`
      const uid = await redis.get(key)
      if (uid) {
        await redis.del(key).catch(() => {})
        resolvedUserId = uid
      }
    } else if (token) {
      // Legacy fallback: JWT in querystring (kept for transition; frontend now
      // uses tickets). Remove once all clients have updated.
      const payload = verifyAccessToken(token)
      if (payload) resolvedUserId = payload.userId
    }

    if (!resolvedUserId) throw new AppError('UNAUTHORIZED', 'Authentication required', 401)

    const user = await db.user.findUnique({
      where: { id: resolvedUserId },
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
