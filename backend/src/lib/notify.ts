/**
 * Central notification helper.
 * Creates a DB notification then fires SSE + push side-effects — all fire-and-forget.
 */
import { db } from './prisma'
import { Prisma } from '@prisma/client'
import { sseEmit } from './sse'
import { sendPushToUser } from './push.service'
import { sendTelegramNotification } from './telegram.notify'
import { logger } from './logger'

export interface NotifyOptions {
  /**
   * "Quiet" delivery — write the in-app notification + fire the live SSE bell
   * update, but DO NOT buzz the user's device (no web push, no Telegram).
   *
   * Use for Tier-2 informational events the user will see next time they open
   * the app, and for coalesced bursts (e.g. the 2nd..Nth chat message within a
   * short window — the first one buzzed, the rest just update the bell). This is
   * the core lever that keeps engagement high without notification fatigue.
   */
  silent?: boolean
  /**
   * Explicit override for whether this notification may be DM'd on Telegram.
   * When omitted, the decision falls back to the TELEGRAM_IMPORTANT_TYPES
   * allowlist below. Pass `false` to force-exclude an otherwise-allowlisted type
   * (e.g. chat messages, which share type 'trade' but are NOT important enough
   * for a Telegram DM).
   */
  telegram?: boolean
}

/**
 * DEFAULT-DENY Telegram allowlist. A notification is DM'd on Telegram ONLY if its
 * `type` is in this set (or NotifyOptions.telegram === true). Everything else
 * stays web-push + in-app only.
 *
 * This deliberately keeps Telegram DMs MINIMAL — limited to important, money /
 * settlement / security events the user actively caused. Low DM volume keeps our
 * block + report rate low, which is what keeps the bot safely inside Telegram's
 * guidelines. When unsure, leave a type OUT — missing a DM is always safer than
 * over-messaging. Excluded on purpose: chat messages, bid notifications, generic
 * info ticks, badges.
 */
const TELEGRAM_IMPORTANT_TYPES = new Set<string>([
  // ── P2P trade settlement + security ──
  'trade',        // payment proof / payment confirmed / crypto sent / completed / cancelled
  'dispute',      // dispute opened / resolved
  'kyc',          // identity verification result
  'moderation',   // account restricted (security)
  'AD_TRADE_READY', // a marketplace trade just opened
  // ── CTM: settlement / escrow / dispute / completion (NOT bid noise) ──
  'ctm_trade_created', // a CTM trade just opened against the merchant's listing
  'CTM_PAYMENT_UPLOADED', 'CTM_PAYMENT_CONFIRMED', 'CTM_SELLER_TRANSFERRING',
  'CTM_TOKEN_PROOF_SUBMITTED', 'CTM_ESCROW_CONFIRMED', 'CTM_TRADE_READY',
  'CTM_TRADE_COMPLETED', 'CTM_AUTO_COMPLETED', 'CTM_TRADE_CANCELLED',
  'CTM_TRADE_EXPIRED', 'CTM_DISPUTE_OPENED', 'CTM_DISPUTE_RESOLVED',
  'CTM_DISPUTE_MESSAGE', 'CTM_AUTO_DISPUTE', 'CTM_BID_ACCEPTED',
])

/**
 * CTM events that are pure noise for a Telegram DM. Every OTHER CTM_* type is a
 * settlement / escrow / deadline event the user must act on, so the allowlist
 * above is extended by prefix instead of by hand — the hand-maintained list had
 * silently missed CTM_CRYPTO_CONFIRMED, CTM_PAYMENT_REJECTED, the confirm
 * reminders and the final warning, which is why some steps never reached
 * Telegram while their neighbours did.
 */
const CTM_TELEGRAM_EXCLUDED = new Set<string>([
  'CTM_BID_EXPIRED', 'CTM_BID_RECEIVED', 'CTM_BID_REJECTED', 'CTM_BID_ACCEPTED_PENDING',
  'CTM_TIER_PROMOTED', 'CTM_AUTO_TIER_UPGRADE', 'CTM_MERCHANT_TIER_CHANGED', 'CTM_PROOF_REVIEWED_OK',
])

function wantsTelegramDefault(type: string): boolean {
  if (TELEGRAM_IMPORTANT_TYPES.has(type)) return true
  return type.startsWith('CTM_') && !CTM_TELEGRAM_EXCLUDED.has(type)
}

/**
 * Persist the bell row, retrying transient DB failures. notify() is called after
 * the trade transaction has already committed, so a single dropped write (pool
 * timeout, brief connection reset) used to lose the notification AND every push
 * and Telegram message chained off it — with no log line at all.
 */
async function createNotificationWithRetry(data: Prisma.NotificationUncheckedCreateInput) {
  const delays = [250, 1000]
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.notification.create({ data })
    } catch (err) {
      if (attempt >= delays.length) throw err
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }
}

export function notify(
  userId: string,
  type: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
  /** If provided, the push notification deep-links to /trade/<id> */
  tradeId?: string,
  /** Explicit push deep-link URL — overrides the tradeId-based default (e.g. CTM rooms). */
  pushUrl?: string,
  options?: NotifyOptions,
) {
  createNotificationWithRetry({ userId, type, title, body, metadata: metadata as Prisma.InputJsonValue })
    .then((notif) => {
      // In-app bell ALWAYS updates live, even for silent notifications.
      sseEmit(userId, { type: 'notification', payload: notif })

      // Silent (Tier-2 / coalesced) — stop here. No device buzz.
      if (options?.silent) return

      const url = pushUrl ?? (tradeId ? `/trade/${tradeId}` : '/notifications')
      sendPushToUser(userId, { title, body, url }).catch((err) => logger.warn({ err, userId, type }, 'notify: push failed'))

      // Telegram is MINIMAL by design: only important money/security events
      // (allowlist) are DM'd, unless a caller explicitly overrides. Keeping DM
      // volume low keeps block/report rates low → keeps the bot ban-safe.
      const wantsTelegram = options?.telegram ?? wantsTelegramDefault(type)
      if (!wantsTelegram) return

      // Telegram bot delivery — only for accounts that linked Telegram AND that
      // we are still allowed to message (telegramBlockedAt null). Reaches iPhone
      // users who never installed the PWA, where web push is unavailable.
      // Fire-and-forget. On a 403 we record the block so we never DM them again
      // (the top Telegram ban trigger); 429s are simply skipped — no retry storm.
      db.user
        .findUnique({ where: { id: userId }, select: { telegramId: true, telegramBlockedAt: true } })
        .then((u) => {
          if (!u?.telegramId || u.telegramBlockedAt) return
          const tgId = u.telegramId
          sendTelegramNotification(tgId, title, body, url)
            .then((r) => {
              if (r.blocked) {
                db.user.updateMany({ where: { telegramId: tgId }, data: { telegramBlockedAt: new Date() } }).catch(() => {})
              } else if (!r.ok) {
                // Not a permanent block — throttled, rate-limited or a transient API
                // error. Log it so a "Telegram stopped" report is diagnosable.
                logger.warn({ userId, type, status: r.status, throttledLocally: r.throttledLocally, retryAfter: r.retryAfter }, 'notify: telegram not delivered')
              }
            })
            .catch((err) => logger.warn({ err, userId, type }, 'notify: telegram send threw'))
        })
        .catch((err) => logger.warn({ err, userId, type }, 'notify: telegram lookup failed'))
    })
    .catch((err) => logger.error({ err, userId, type }, 'notify: notification could not be saved'))
}
