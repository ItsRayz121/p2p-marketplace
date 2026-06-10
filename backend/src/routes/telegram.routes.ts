import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { validateInitData, parseReferralStartParam } from '../lib/telegram'
import { loginOrRegisterWithTelegram, COOKIE_OPTIONS } from '../services/auth.service'

const miniAppAuthSchema = z.object({
  initData: z.string().min(1, 'initData is required'),
})

export async function telegramRoutes(app: FastifyInstance) {
  // POST /api/v1/miniapp/auth — validate Telegram initData, get-or-create the
  // account, and issue a session. The frontend calls this on Mini App launch.
  //
  // Returns the access token in the body (the Mini App stores it as an in-memory
  // Bearer token because Telegram's WebView blocks cross-site cookies) AND sets
  // the httpOnly refresh cookie best-effort (works when the API shares the site).
  app.post(
    '/miniapp/auth',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw new AppError('SERVICE_UNAVAILABLE', 'Telegram Mini App is not configured', 503)
      }

      const { initData } = miniAppAuthSchema.parse(req.body)
      const validated = validateInitData(initData)
      if (!validated) {
        // Covers bad HMAC, stale auth_date, and malformed payloads alike — never
        // disclose which, to avoid handing an attacker an oracle.
        throw new AppError('UNAUTHORIZED', 'Invalid Telegram launch data', 401)
      }

      const referralCode = parseReferralStartParam(validated.startParam) ?? undefined
      const ua = req.headers['user-agent']

      const result = await loginOrRegisterWithTelegram({
        telegramId: validated.user.id,
        firstName: validated.user.firstName,
        ...(validated.user.username ? { username: validated.user.username } : {}),
        ...(validated.user.photoUrl ? { photoUrl: validated.user.photoUrl } : {}),
        ...(referralCode ? { referralCode } : {}),
        ...(ua ? { userAgent: ua } : {}),
        ip: req.ip,
      })

      // Banned / suspended → restricted appeal payload (no session issued).
      if (result.restricted) {
        return reply.status(403).send({ success: false, error: 'ACCOUNT_RESTRICTED', data: { restricted: result.restricted } })
      }

      if (result.refreshToken) {
        reply.setCookie('refresh_token', result.refreshToken, COOKIE_OPTIONS)
      }

      return reply.send({
        success: true,
        data: {
          accessToken: result.accessToken,
          user: result.user,
          isNew: result.isNew,
        },
      })
    },
  )
}
