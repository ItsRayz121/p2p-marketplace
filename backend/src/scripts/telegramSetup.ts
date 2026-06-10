/**
 * One-shot Telegram bot setup. Run this AFTER setting the Telegram env vars
 * (locally or on Railway). It performs the parts of BotFather config that the
 * Bot API can do for you, so you don't have to click through @BotFather:
 *
 *   - getMe                → verifies the token and prints the bot @username
 *   - setMyCommands        → registers /start
 *   - setMyDescription     → long "what is this bot" text (shown on the bot's
 *                            profile / empty-chat screen)
 *   - setMyShortDescription→ short about text
 *   - setChatMenuButton    → makes the blue Menu button open the Mini App
 *   - setWebhook           → points Telegram at your backend (only if
 *                            TELEGRAM_WEBHOOK_URL is set; the backend also does
 *                            this on boot, so this is just an explicit re-apply)
 *
 * Required env: TELEGRAM_BOT_TOKEN
 * Recommended : TELEGRAM_MINI_APP_URL (or FRONTEND_URL), TELEGRAM_WEBHOOK_URL,
 *               TELEGRAM_WEBHOOK_SECRET
 *
 * Usage:
 *   npm run telegram:setup --workspace=backend
 *   # or
 *   npx tsx src/scripts/telegramSetup.ts
 */
import 'dotenv/config'
import { env } from '../lib/env'

const API = 'https://api.telegram.org'

async function call(method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  if (!json.ok) throw new Error(`${method} failed: ${json.description ?? res.status}`)
  return json.result
}

function miniAppUrl(): string {
  return env.TELEGRAM_MINI_APP_URL ?? `${env.FRONTEND_URL}/mini-app`
}

async function main(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set. Set it (and the other TELEGRAM_* vars) first.')
    process.exit(1)
  }

  // 1. Verify token
  const me = (await call('getMe')) as { username?: string; first_name?: string; id?: number }
  console.log(`✓ Token OK — bot is @${me.username} (${me.first_name}, id ${me.id})`)

  // 2. Commands
  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Open RupChain & sign in' },
      { command: 'help', description: 'How the bot works' },
    ],
  })
  console.log('✓ Commands set (/start, /help)')

  // 3. Descriptions
  await call('setMyDescription', {
    description:
      "RupChain — Pakistan's trusted P2P crypto marketplace. Buy & sell USDT with " +
      'JazzCash, Easypaisa & bank transfer, escrow-protected. Tap the menu button to open the app.',
  })
  await call('setMyShortDescription', {
    short_description: "Pakistan's P2P crypto marketplace — buy & sell USDT, escrow-protected.",
  })
  console.log('✓ Description + short description set')

  // 4. Menu button → Mini App (replaces the manual BotFather menu-button step)
  const appUrl = miniAppUrl()
  await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Open RupChain', web_app: { url: appUrl } },
  })
  console.log(`✓ Menu button opens the Mini App → ${appUrl}`)

  // 5. Webhook (optional — backend also registers on boot)
  if (env.TELEGRAM_WEBHOOK_URL) {
    const webhookUrl = `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}/api/v1/telegram/webhook`
    await call('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message'],
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: env.TELEGRAM_WEBHOOK_SECRET } : {}),
    })
    console.log(`✓ Webhook set → ${webhookUrl}${env.TELEGRAM_WEBHOOK_SECRET ? ' (secured)' : ' (no secret!)'}`)
  } else {
    console.log('• TELEGRAM_WEBHOOK_URL not set — skipped setWebhook (the backend will register it on boot)')
  }

  console.log('\n✅ Telegram bot setup complete. Open the bot, tap Menu, and you should land on the dashboard.')
}

main().catch((err) => {
  console.error('❌ Setup failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
