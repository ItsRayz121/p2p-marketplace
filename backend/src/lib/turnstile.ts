import { env } from './env'
import { logger } from './logger'
import { AppError } from './errors'

/**
 * Cloudflare Turnstile verification. Feature-flagged on TURNSTILE_SECRET_KEY:
 *   - unset  → no-op (feature off; nothing to verify)
 *   - set    → the request must carry a valid Turnstile token
 *
 * Fails OPEN if Cloudflare itself is unreachable — a CF outage must not lock
 * every user out of login/registration. The per-account brute-force counters
 * in auth.service remain active either way.
 */
export async function assertTurnstileValid(token: string | undefined, ip?: string): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) return

  if (!token) {
    throw new AppError('CAPTCHA_REQUIRED', 'Please complete the security check and try again.', 403)
  }

  let ok: boolean
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    ok = !!data.success
    if (!ok) {
      logger.warn({ errorCodes: data['error-codes'] }, 'Turnstile verification rejected')
    }
  } catch (err) {
    logger.error({ err }, 'Turnstile siteverify unreachable — failing open')
    return
  }

  if (!ok) {
    throw new AppError('CAPTCHA_FAILED', 'Security check failed. Please refresh the page and try again.', 403)
  }
}
