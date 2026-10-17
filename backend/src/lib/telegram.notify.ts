// Outbound bot push: deliver an in-app notification to a user's Telegram chat.
//
// Kept standalone (imports ONLY env + logger) so notify.ts can call it without
// pulling in the bot service's heavier dependency graph (db, accountLink, …) —
// that avoids any import cycle through the central notify() helper.
//
// ── TELEGRAM BAN-SAFETY (read before changing send logic) ───────────────────
// We treat NOT sending as always safer than risking a bot ban:
//   • 403 ("bot was blocked" / "can't initiate conversation") → caller records
//     telegramBlockedAt and NEVER messages that user again until they /start.
//     Looping on blocked users is the #1 ban trigger.
//   • 429 → Bot API 7.0+ returns retry_after (seconds). We surface it; callers
//     honor it (broadcast backs off; transactional just skips — no retry storm).
//   • We only message users who have a telegramId AND no telegramBlockedAt.
// No-ops gracefully when TELEGRAM_BOT_TOKEN is unset.
import { env } from './env'
import { telegramRequest, type TgResult } from './telegram.client'

export type TelegramSendResult = TgResult

function miniAppUrl(): string {
  return env.TELEGRAM_MINI_APP_URL ?? `${env.FRONTEND_URL}/mini-app`
}

// All sends route through the global gateway (rate limiter + 429/403 handling).
function sendMessage(chatId: bigint, text: string, button: Record<string, unknown>): Promise<TelegramSendResult> {
  return telegramRequest('sendMessage', {
    chat_id: chatId.toString(),
    text,
    // Plain text on purpose — no parse_mode. Telegram rejects messages with
    // unbalanced Markdown special chars, silently dropping the notification.
    reply_markup: { inline_keyboard: [[button]] },
    disable_web_page_preview: true,
  })
}

/**
 * Send a notification to one Telegram user (private chat id == their user id).
 * `path` is the in-app destination (e.g. "/trade/abc") — forwarded to the Mini
 * App bridge via ?path= so the "Open" button lands on the relevant screen.
 */
export async function sendTelegramNotification(
  telegramId: bigint,
  title: string,
  body: string,
  path?: string,
): Promise<TelegramSendResult> {
  const safePath = path && path.startsWith('/') && !path.startsWith('//') ? path : undefined
  const url = safePath ? `${miniAppUrl()}?path=${encodeURIComponent(safePath)}` : miniAppUrl()
  return sendMessage(telegramId, `🔔 ${title}\n\n${body}`, { text: '🔗 Open in RupChain', web_app: { url } })
}

/**
 * Send an ADMIN alert to one staff member's Telegram. The button opens the admin page INSIDE Telegram as
 * a Mini App (so Telegram shows no "Open this link?" prompt) and signs in as the admin's own linked
 * account, then lands on `href`, an in-app admin path like "/admin/kyc". Pass `rows` to replace the
 * default button with action buttons (gas orders).
 */
export async function sendTelegramAdminAlert(
  telegramId: bigint,
  title: string,
  body: string,
  href?: string,
  rows?: ReadonlyArray<ReadonlyArray<object>>,
): Promise<TelegramSendResult> {
  const safeHref = href && href.startsWith('/') && !href.startsWith('//') ? href : '/admin'
  const base = miniAppUrl()
  const miniUrl = `${base}${base.includes('?') ? '&' : '?'}path=${encodeURIComponent(safeHref)}`
  // A Mini App button must be https; in local development fall back to a plain link.
  const button = /^https:\/\//i.test(miniUrl)
    ? { text: '🔗 Open admin panel', web_app: { url: miniUrl } }
    : { text: '🔗 Open admin panel', url: `${env.FRONTEND_URL}${safeHref}` }
  return telegramRequest('sendMessage', {
    chat_id: telegramId.toString(),
    text: `🔔 ${title}

${body}`,
    reply_markup: { inline_keyboard: rows && rows.length > 0 ? rows : [[button]] },
    disable_web_page_preview: true,
  })
}

/**
 * Send a broadcast ANNOUNCEMENT to one Telegram user. Same structured result so
 * the broadcast job can honor retry_after and record blocked users.
 *
 * The CTA button uses an absolute http(s) `linkUrl` as a plain url-button; an
 * internal path (or no link) opens the Mini App via ?path= like normal notifs.
 */
export async function sendTelegramAnnouncement(
  telegramId: bigint,
  title: string,
  body: string,
  linkUrl?: string,
): Promise<TelegramSendResult> {
  let button: Record<string, unknown>
  if (linkUrl && /^https?:\/\//i.test(linkUrl)) {
    button = { text: '🔗 Open', url: linkUrl }
  } else {
    const safePath = linkUrl && linkUrl.startsWith('/') && !linkUrl.startsWith('//') ? linkUrl : undefined
    const url = safePath ? `${miniAppUrl()}?path=${encodeURIComponent(safePath)}` : miniAppUrl()
    button = { text: '🔗 Open RupChain', web_app: { url } }
  }
  return sendMessage(telegramId, `📢 ${title}\n\n${body}`, button)
}
