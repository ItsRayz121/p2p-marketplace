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

async function callTelegram(method: string, body: Record<string, unknown>): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) return
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logger.warn({ method, status: res.status, text }, 'Telegram API call failed')
    }
  } catch (err) {
    logger.warn({ err, method }, 'Telegram API call threw')
  }
}

function miniAppUrl(): string {
  return env.TELEGRAM_MINI_APP_URL ?? `${env.FRONTEND_URL}/mini-app`
}

function openAppKeyboard() {
  return { inline_keyboard: [[{ text: '🚀 Open RupChain', web_app: { url: miniAppUrl() } }]] }
}

async function sendWelcome(chatId: number, firstName?: string): Promise<void> {
  const name = firstName?.trim() || 'there'
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      `👋 Welcome to RupChain, ${name}!\n\n` +
      `Pakistan's trusted P2P crypto marketplace — buy & sell USDT with JazzCash, ` +
      `Easypaisa & bank transfer, escrow-protected.\n\n` +
      `Inside the app you can:\n` +
      `• 💱 Buy & sell USDT at the best PKR rates\n` +
      `• 🛡️ Trade safely with escrow + dispute protection\n` +
      `• ⚡ Instant-buy and the P2P marketplace\n` +
      `• 🎁 Invite friends and earn referral rewards\n\n` +
      `Tap below to open the app — you'll be signed in automatically. ` +
      `Send /help any time.`,
    reply_markup: openAppKeyboard(),
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

// Process a single webhook update. Only /start is meaningful today; other
// messages get a gentle nudge to open the Mini App.
export async function handleTelegramUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.from || msg.from.is_bot || !msg.chat) return

  const text = (msg.text ?? '').trim()
  const fromId = msg.from.id
  const chatId = msg.chat.id

  if (text.startsWith('/start')) {
    // "/start ref_ABC123" → payload after the first space
    const payload = text.split(/\s+/)[1]
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
  const webhookUrl = `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}/api/v1/telegram/webhook`
  await callTelegram('setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message'],
    ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
  })
  logger.info({ webhookUrl }, 'Telegram webhook registered')
}
