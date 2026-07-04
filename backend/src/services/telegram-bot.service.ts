// Telegram bot — webhook-driven (no long polling, which suits Railway).
//
// Responsibilities:
//   1. Register the webhook with Telegram on boot (when configured).
//   2. Handle the /start command, capturing a `ref_<code>` deep-link payload as
//      a PENDING referral keyed by the Telegram user id — the account does not
//      exist yet at /start time, so attribution is resolved later by
//      /api/v1/miniapp/auth when the user actually launches the Mini App.
//   3. Reply with a welcome message + a button that opens the Mini App.
//
// Everything no-ops gracefully when TELEGRAM_BOT_TOKEN is unset.
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { db } from '../lib/prisma'
import { parseReferralStartParam } from '../lib/telegram'
import { linkTelegramViaToken } from './accountLink.service'
import { telegramRequest } from '../lib/telegram.client'

const API_BASE = 'https://api.telegram.org'

interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}
interface TgMessage {
  message_id: number
  from?: TgUser
  chat?: { id: number; type: string }
  text?: string
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
}

// Bot chat replies (welcome / help / link outcome). Routed through the SAME
// global gateway as notifications so replies count against the shared 25/sec
// budget and never push us toward the ceiling — even if the webhook is flooded.
// Reply-driven and single-shot: on throttle / 429 / block we simply drop the
// reply (never retry), because a missed reply is harmless next to a ban.
async function callTelegram(method: string, body: Record<string, unknown>): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return
  await telegramRequest(method, body)
}

function miniAppUrl(): string {
  return env.TELEGRAM_MINI_APP_URL ?? `${env.FRONTEND_URL}/mini-app`
}

// Deep-link a Mini App button to a specific in-app screen. The /mini-app auth
// bridge honours a ?path= query and forwards there after sign-in.
function miniAppUrlAt(path: string): string {
  const base = miniAppUrl()
  return `${base}${base.includes('?') ? '&' : '?'}path=${encodeURIComponent(path)}`
}

// Single "Open app" button — used on link/help confirmations.
function openAppKeyboard() {
  return { inline_keyboard: [[{ text: '🚀 Open RupChain', web_app: { url: miniAppUrl() } }]] }
}

// Full action menu — the welcome screen. Every button opens the Mini App at the
// relevant screen (auto sign-in).
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚀 Open RupChain', web_app: { url: miniAppUrl() } }],
      [
        { text: '💱 USDT Market', web_app: { url: miniAppUrlAt('/marketplace') } },
        { text: '🪙 CTM Tokens', web_app: { url: miniAppUrlAt('/ctm') } },
      ],
      [
        { text: '⛽ Crypto Gas Fees', web_app: { url: miniAppUrlAt('/gas') } },
        { text: '🎁 Referral', web_app: { url: miniAppUrlAt('/referral') } },
      ],
      [
        { text: '📋 Orders', web_app: { url: miniAppUrlAt('/orders') } },
        { text: '👛 Wallet', web_app: { url: miniAppUrlAt('/wallet') } },
      ],
    ],
  }
}

async function sendWelcome(chatId: number, firstName?: string): Promise<void> {
  const name = firstName?.trim() || 'there'
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      `👋 Welcome to RupChain, ${name}!\n\n` +
      `People's trusted P2P crypto marketplace — buy & sell USDT with JazzCash, ` +
      `Easypaisa & bank transfer, protected.\n\n` +
      `Inside the app you can:\n` +
      `• 💱 Buy & sell USDT at the best PKR rates\n` +
      `• 🪙 Trade community tokens — Sidra, Pi, Interlink & more\n` +
      `• ⛽ Top up blockchain gas fees on any chain with PKR or crypto\n` +
      `• 🛡️ Trade safely with on-chain + dispute protection\n` +
      `• 🎁 Invite friends and earn referral rewards in $ USDT\n\n` +
      `Tap a button below to jump straight in — you'll be signed in automatically. ` +
      `Send /help any time.`,
    reply_markup: mainMenuKeyboard(),
  })
}

async function sendHelp(chatId: number): Promise<void> {
  // Plain text on purpose — no parse_mode. Telegram rejects messages with
  // unbalanced Markdown special chars, which would silently drop the reply.
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      `ℹ️ RupChain help\n\n` +
      `/start — open the app (auto sign-in)\n` +
      `/help — show this message\n\n` +
      `Everything happens inside the Mini App: trading, wallet, KYC, referrals and ` +
      `support. Tap the button below or the Menu button to open it.\n\n` +
      `Need a human? Use in-app Support once you're signed in.`,
    reply_markup: openAppKeyboard(),
  })
}

// Resolve a `/start link_<token>` deep link: attach this Telegram account to
// the website account that minted the token, then report the outcome in chat.
async function handleAccountLink(
  chatId: number,
  token: string,
  telegramId: number,
  username?: string,
): Promise<void> {
  let outcome: Awaited<ReturnType<typeof linkTelegramViaToken>>
  try {
    outcome = await linkTelegramViaToken({
      token,
      telegramId,
      ...(username ? { username } : {}),
    })
  } catch (err) {
    logger.warn({ err, telegramId }, 'Account-link via token threw')
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Something went wrong linking your account. Please try again from the website Settings.',
    })
    return
  }

  if (outcome.ok) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text:
        `✅ Done! This Telegram account is now linked to your RupChain account.\n\n` +
        `You can open the app right here and you'll be signed into the same account.`,
      reply_markup: openAppKeyboard(),
    })
    return
  }

  const messages: Record<typeof outcome.reason, string> = {
    expired: '⌛ This link has expired. Please generate a new one from the website Settings and try again.',
    already_linked_self: 'ℹ️ Your RupChain account is already linked to a Telegram account.',
    telegram_in_use:
      '🚫 This Telegram account already has trade history on RupChain, so it can’t be bound to another account. ' +
      'For your security the two can’t be merged — please continue using them separately, or contact support.',
    restricted: '🚫 This account is currently restricted and can’t be linked.',
  }
  await callTelegram('sendMessage', { chat_id: chatId, text: messages[outcome.reason] })
}

// Process a single webhook update. Only /start is meaningful today; other
// messages get a gentle nudge to open the Mini App.
export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.from || msg.from.is_bot || !msg.chat) return

  const text = (msg.text ?? '').trim()
  const fromId = msg.from.id
  const chatId = msg.chat.id

  // Any inbound message proves the bot CAN reach this user — clear a prior
  // 403 block flag so they become reachable for notifications again. (Fixes the
  // case where a Mini-App user who never /start-ed got flagged on first send,
  // then later starts the bot.) Fire-and-forget; no-ops if no account yet.
  db.user
    .updateMany({ where: { telegramId: BigInt(fromId), telegramBlockedAt: { not: null } }, data: { telegramBlockedAt: null } })
    .catch(() => {})

  if (text.startsWith('/start')) {
    // "/start ref_ABC123" → payload after the first space
    const payload = text.split(/\s+/)[1]

    // "/start link_<token>" — a website user attaching this Telegram account.
    // Handled here (NOT in the Mini App auth path) so it never interferes with
    // auto sign-in. We reply with the outcome and stop.
    const linkMatch = /^link_([A-Za-z0-9_-]{16,64})$/.exec(payload ?? '')
    if (linkMatch) {
      await handleAccountLink(chatId, linkMatch[1]!, fromId, msg.from.username)
      return
    }

    const code = parseReferralStartParam(payload)
    if (code) {
      // Stash the referral keyed by Telegram id. Upsert so a fresh /start
      // overwrites a stale code; deleted once consumed at miniapp/auth time.
      try {
        await db.telegramPendingReferral.upsert({
          where: { telegramId: BigInt(fromId) },
          create: { telegramId: BigInt(fromId), referralCode: code },
          update: { referralCode: code },
        })
        logger.info({ fromId, code }, 'Stashed pending Telegram referral')
      } catch (err) {
        logger.warn({ err, fromId }, 'Failed to stash pending Telegram referral')
      }
    }
    await sendWelcome(chatId, msg.from.first_name)
    return
  }

  if (text.startsWith('/help')) {
    await sendHelp(chatId)
    return
  }

  // Any other text — point them at the app.
  await sendWelcome(chatId, msg.from.first_name)
}

// Log which bot the configured token actually belongs to. This is the fastest
// way to diagnose Mini App "Invalid Telegram launch data" (HTTP 401) errors:
// if this @username is NOT the bot the user is opening, the token is for the
// wrong bot and the initData HMAC can never match. Fire-and-forget on boot.
export async function logTelegramBotIdentity(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return
  try {
    const res = await fetch(`${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
    const json = (await res.json()) as { ok: boolean; result?: { username?: string; id?: number }; description?: string }
    if (json.ok && json.result) {
      logger.info(
        { botUsername: json.result.username, botId: json.result.id },
        `Telegram token resolves to @${json.result.username} — this MUST match the bot whose Mini App users open`,
      )
    } else {
      logger.error({ description: json.description }, 'TELEGRAM_BOT_TOKEN is set but getMe failed — token is invalid')
    }
  } catch (err) {
    logger.warn({ err }, 'Could not verify Telegram bot identity (getMe)')
  }
}

// Register the webhook with Telegram. Called fire-and-forget on boot.
export async function registerTelegramWebhook(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram bot not configured (TELEGRAM_BOT_TOKEN unset) — skipping webhook registration')
    return
  }
  if (!env.TELEGRAM_WEBHOOK_URL) {
    logger.warn('TELEGRAM_BOT_TOKEN set but TELEGRAM_WEBHOOK_URL unset — webhook NOT registered')
    return
  }
  // The secret token is what stops a third party POSTing forged updates to our
  // public webhook (which could make the bot fire replies and rack up failed
  // sends → ban risk). In PRODUCTION we refuse to register the webhook without
  // it — the bot stays safely inert until configured, rather than spoofable.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    if (env.NODE_ENV === 'production') {
      logger.error('TELEGRAM_WEBHOOK_SECRET is NOT set — refusing to register the Telegram webhook in production (spoofing risk). Set the secret to enable the bot.')
      return
    }
    logger.warn('TELEGRAM_WEBHOOK_SECRET is NOT set — webhook is unauthenticated (dev only). Set it before production.')
  }
  const webhookUrl = `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}/api/v1/telegram/webhook`
  await callTelegram('setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message'],
    ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
  })
  logger.info({ webhookUrl }, 'Telegram webhook registered')
}
