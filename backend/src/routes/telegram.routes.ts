import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'
import { validateInitData, parseReferralStartParam } from '../lib/telegram'
import { loginOrRegisterWithTelegram, COOKIE_OPTIONS } from '../services/auth.service'
import { handleTelegramUpdate } from '../services/telegram-bot.service'
import { logger } from '../lib/logger'

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
    // Generous limit on purpose: initData is HMAC-validated, so brute-force is
    // pointless (forged data just 401s). Pakistani mobile carriers use
    // carrier-grade NAT — many Telegram users share one IP, and every app
    // open/reload re-auths here — so a tight per-IP cap would 429 legitimate
    // logins. Keyed by IP like all routes.
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
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

  // POST /api/v1/telegram/webhook — receives bot updates from Telegram.
  // Telegram echoes our secret in the X-Telegram-Bot-Api-Secret-Token header;
  // we reject anything that doesn't match so the public endpoint can't be
  // spoofed. We always reply 200 quickly (after handling) so Telegram does not
  // retry — processing errors are swallowed and logged, never surfaced.
  app.post(
    '/telegram/webhook',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const secret = env.TELEGRAM_WEBHOOK_SECRET
      if (secret) {
        const provided = req.headers['x-telegram-bot-api-secret-token']
        if (provided !== secret) {
          return reply.status(401).send({ success: false, error: 'UNAUTHORIZED' })
        }
      }
      try {
        await handleTelegramUpdate(req.body as Parameters<typeof handleTelegramUpdate>[0])
      } catch (err) {
        logger.warn({ err }, 'Telegram webhook handler error')
      }
      return reply.send({ ok: true })
    },
  )
}
