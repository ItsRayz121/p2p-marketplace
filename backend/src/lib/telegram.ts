// Telegram Mini App initData validation.
//
// initData is the launch payload Telegram appends to the Mini App URL as
// `tgWebAppData` (and exposes via the SDK as `WebApp.initData`). It is a
// URL-encoded querystring whose integrity is proven by an HMAC keyed on the
// bot token. We validate it per Telegram's official algorithm and extract the
// verified user + deep-link start_param.
//
// Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from './env'
import { logger } from './logger'

export interface TelegramInitUser {
  id: number
  firstName: string
  lastName?: string
  username?: string
  photoUrl?: string
  languageCode?: string
  isPremium?: boolean
}

export interface ValidatedInitData {
  user: TelegramInitUser
  authDate: number
  /** Deep-link payload forwarded by Telegram, e.g. "ref_ABC123" from t.me/<bot>?start=ref_ABC123 */
  startParam?: string
  queryId?: string
}

// Max age of a launch before we reject it as stale (replay window). 24h matches
// the spec; Telegram refreshes initData on every open so a fresh launch is cheap.
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60

/**
 * Validate a raw initData string against the bot token via HMAC-SHA256.
 * Returns the verified payload on success, or null on any failure
 * (bad signature, missing/expired auth_date, malformed user, no bot token).
 *
 * The caller MUST treat a null return as "not authenticated" — never trust
 * any field of initData that has not passed this function.
 */
export function validateInitData(initData: string): ValidatedInitData | null {
  const botToken = env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    logger.warn('validateInitData called but TELEGRAM_BOT_TOKEN is not set')
    return null
  }
  if (!initData || typeof initData !== 'string') return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(initData)
  } catch {
    return null
  }

  const hash = params.get('hash')
  if (!hash) return null

  // Build the data-check-string: EVERY received field except `hash` itself,
  // each "key=value" with the DECODED value (URLSearchParams decodes for us),
  // sorted by key, joined by \n.
  //
  // IMPORTANT: `signature` MUST be included here. Modern Telegram clients
  // (Bot API 7.10+) attach a `signature` field to every initData, and the
  // `hash` is computed by Telegram over all fields except `hash` — INCLUDING
  // `signature`. (`signature` is only excluded in the *separate* Ed25519
  // third-party validation flow, which we don't use.) Excluding it here makes
  // the HMAC never match on current clients → every Mini App login 401s.
  const pairs: string[] = []
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue
    pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  const dataCheckString = pairs.join('\n')

  // secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
  // expected   = HMAC_SHA256(key=secret_key, msg=data_check_string)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  // Constant-time comparison — both are hex of equal length on the happy path.
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(hash, 'hex')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    // Diagnostic (no secrets): field keys + whether a signature was present, so
    // a recurring HMAC mismatch is debuggable from the logs. The bot token and
    // field VALUES are never logged.
    logger.warn(
      { fields: pairs.map((p) => p.split('=')[0]), hasSignature: params.has('signature') },
      'initData HMAC mismatch — rejecting launch data',
    )
    return null
  }

  // Freshness — reject stale launches to limit initData replay.
  const authDateRaw = params.get('auth_date')
  const authDate = authDateRaw ? Number(authDateRaw) : NaN
  if (!Number.isFinite(authDate)) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec - authDate > MAX_AUTH_AGE_SECONDS) return null

  // Parse the verified user object.
  const userRaw = params.get('user')
  if (!userRaw) return null
  let userJson: Record<string, unknown>
  try {
    userJson = JSON.parse(userRaw) as Record<string, unknown>
  } catch {
    return null
  }
  const id = typeof userJson.id === 'number' ? userJson.id : Number(userJson.id)
  if (!Number.isFinite(id) || id <= 0) return null

  const user: TelegramInitUser = {
    id,
    firstName: typeof userJson.first_name === 'string' ? userJson.first_name : '',
    ...(typeof userJson.last_name === 'string' ? { lastName: userJson.last_name } : {}),
    ...(typeof userJson.username === 'string' ? { username: userJson.username } : {}),
    ...(typeof userJson.photo_url === 'string' ? { photoUrl: userJson.photo_url } : {}),
    ...(typeof userJson.language_code === 'string' ? { languageCode: userJson.language_code } : {}),
    ...(userJson.is_premium === true ? { isPremium: true } : {}),
  }

  const startParam = params.get('start_param') ?? undefined
  const queryId = params.get('query_id') ?? undefined

  return {
    user,
    authDate,
    ...(startParam ? { startParam } : {}),
    ...(queryId ? { queryId } : {}),
  }
}

/**
 * Extract a referral code from a deep-link payload. Telegram deep links use the
 * canonical form `ref_<code>` (t.me/<bot>?start=ref_<code>). Returns the bare
 * code, or null if the payload is absent / not a referral payload.
 */
export function parseReferralStartParam(startParam: string | undefined): string | null {
  if (!startParam) return null
  const match = /^ref_([A-Za-z0-9_-]{1,64})$/.exec(startParam)
  return match ? match[1]! : null
}

/**
 * Extract a referral code from ANY supported deep-link payload:
 *  - a plain referral link:            `ref_<code>`
 *  - a shared LISTING deep link that also carries the sharer's referral:
 *    `L_<kind>_<listingId>_r_<code>` (listing ids are alphanumeric — cuids today,
 *    so `_r_` unambiguously delimits the trailing code; the id class is kept in
 *    sync with the frontend's parseStartParamToPath / buildListingShareLinks so a
 *    future id scheme change can't silently drop referral attribution here).
 *
 * So a brand-new user who taps a shared trade link inside Telegram and auto-
 * registers via the Mini App is attributed to the sharer, exactly like the web
 * `?ref=` flow. `parseReferralStartParam` is left untouched (its tests + the plain
 * `ref_` bot flow keep their exact semantics).
 */
export function extractReferralFromStartParam(startParam: string | undefined): string | null {
  const direct = parseReferralStartParam(startParam)
  if (direct) return direct
  if (!startParam) return null
  const m = /^L_(?:usdt|ctm)_[A-Za-z0-9]+_r_([A-Za-z0-9_-]{1,64})$/.exec(startParam)
  return m ? m[1]! : null
}
