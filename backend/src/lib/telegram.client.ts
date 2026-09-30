// THE single outbound gateway to the Telegram Bot API. EVERY bot message in the
// codebase (transactional notifications, broadcast announcements, and bot chat
// replies) MUST go through telegramRequest() — never call api.telegram.org
// directly elsewhere. Centralising here guarantees, system-wide:
//
//   • a GLOBAL token-bucket caps total send rate under Telegram's 30/sec ceiling
//     (we use 25/sec for headroom) across ALL sources combined — the one thing
//     no per-path limiter can guarantee on its own;
//   • 429 retry_after is surfaced so callers back off (none retry-storm);
//   • 403 / "can't initiate" / deactivated is reported so callers stop forever;
//   • when Redis is down we fall back to a smaller per-instance limit (see
//     withinLocalRate) so we still stay well under budget without going dark.
//
// Ban-safety is a hard project rule — see project_notifications_announcements.
import { env } from './env'
import { logger } from './logger'
import { redis } from './redis'

// Conservative ceiling: Telegram's free limit is ~30 msg/sec globally. 25 leaves
// headroom for clock skew and the odd burst without ever touching the wall.
const GLOBAL_CAP_PER_SEC = 25

export interface TgResult {
  ok: boolean
  /** 403 / can't-initiate / deactivated — caller must stop messaging this user. */
  blocked: boolean
  /** 429 retry_after seconds — caller honors it. */
  retryAfter?: number
  /** Our OWN limiter denied the send — no API call was made. Caller may wait/drop. */
  throttledLocally?: boolean
  status?: number
  result?: unknown
}

// In-process fallback bucket used only while Redis is unreachable. Each instance
// gets a share of the ceiling, so even several instances stay under Telegram's
// 30/sec. This replaces the old "Redis error ⇒ send nothing", which turned a
// Redis blip (or a misconfigured REDIS_URL after a move) into a silent, total
// Telegram outage that looked like "the bot stopped sending".
const LOCAL_CAP_PER_SEC = 8
let localWindow = 0
let localCount = 0
function withinLocalRate(): boolean {
  const now = Math.floor(Date.now() / 1000)
  if (now !== localWindow) { localWindow = now; localCount = 0 }
  localCount += 1
  return localCount <= LOCAL_CAP_PER_SEC
}

// Fixed-window counter per wall-clock second. Atomic INCR; first writer sets a
// short TTL so keys self-expire. On a Redis error we fall back to the local
// per-instance bucket above rather than denying every send.
async function withinGlobalRate(): Promise<boolean> {
  const key = `tg:rate:${Math.floor(Date.now() / 1000)}`
  try {
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, 2)
    return n <= GLOBAL_CAP_PER_SEC
  } catch (err) {
    logger.warn({ err }, 'Telegram global limiter: Redis unavailable — using local per-instance limit')
    return withinLocalRate()
  }
}

export async function telegramRequest(method: string, body: Record<string, unknown>): Promise<TgResult> {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, blocked: false }

  if (!(await withinGlobalRate())) {
    return { ok: false, blocked: false, throttledLocally: true }
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      let result: unknown
      try { result = ((await res.json()) as { result?: unknown }).result } catch { /* ignore */ }
      return { ok: true, blocked: false, status: 200, result }
    }

    let errBody: { description?: string; parameters?: { retry_after?: number } } = {}
    try { errBody = (await res.json()) as typeof errBody } catch { /* non-JSON */ }

    if (res.status === 429) {
      const retryAfter = errBody.parameters?.retry_after ?? 60
      logger.warn({ method, retryAfter }, 'Telegram 429 — honoring retry_after')
      return { ok: false, blocked: false, retryAfter, status: 429 }
    }

    const desc = (errBody.description ?? '').toLowerCase()
    const blocked =
      res.status === 403 ||
      desc.includes('blocked') ||
      desc.includes('chat not found') ||
      desc.includes('user is deactivated') ||
      desc.includes("can't initiate")
    if (!blocked) {
      logger.warn({ method, status: res.status, description: errBody.description }, 'Telegram API call failed')
    }
    return { ok: false, blocked, status: res.status }
  } catch (err) {
    logger.warn({ method, err }, 'Telegram API call threw')
    return { ok: false, blocked: false }
  }
}
