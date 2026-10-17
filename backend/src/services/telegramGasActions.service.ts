import { randomBytes } from 'node:crypto'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { AppError } from '../lib/errors'
import { telegramRequest } from '../lib/telegram.client'
import { isManualProofOrder, isPaidFailed } from '../lib/gas/gas.orderStates'
import { approveManualGasPayment, rejectManualGasPayment, retryGasDelivery } from './gasAdminActions.service'

/**
 * Gas-order buttons inside the admin's Telegram chat.
 *
 * Safety model (money moves from here, so nothing is taken on trust):
 *  - A button carries only an opaque one-off id ("ga:<24 hex>"). What it means (order, action, who it
 *    was made for) lives in Redis, so a forged or edited callback can name no order and no action.
 *  - The tap must come from the very Telegram account the button was made for, in a private chat, and
 *    that account must map to a staff user who is an admin or super admin RIGHT NOW (re-checked per tap).
 *  - Approve, Reject and Retry need a second tap ("Yes, ...") on the same message.
 *  - The action itself is the same shared, compare-and-set function the website uses, so a double tap, two
 *    admins, or Telegram racing the website can never run it twice, and Retry still has to prove that the
 *    earlier delivery transaction is dead before anything is sent again.
 *  - Every action is written to the audit log with the acting admin and via = 'telegram'.
 */

interface TgButton { text: string; callback_data?: string; web_app?: { url: string }; url?: string }
export type TgKeyboard = TgButton[][]

export interface TgCallbackQuery {
  id: string
  from: { id: number; is_bot?: boolean; first_name?: string; username?: string }
  message?: { message_id: number; chat: { id: number; type: string }; text?: string }
  data?: string
}

type Action = 'approve' | 'reject' | 'retry' | 'yes_approve' | 'yes_reject' | 'yes_retry' | 'cancel'
interface Stored { orderId: string; tgId: string; action: Action }

const PREFIX = 'ga:'
const TOKEN_TTL_SECONDS = 48 * 60 * 60
const REJECT_REASON = 'Payment could not be verified'

const keyOf = (token: string) => `tgga:${token}`
const doneKeyOf = (token: string) => `tgga:done:${token}`

function miniAppUrlAt(path: string): string {
  const base = env.TELEGRAM_MINI_APP_URL ?? `${env.FRONTEND_URL}/mini-app`
  return `${base}${base.includes('?') ? '&' : '?'}path=${encodeURIComponent(path)}`
}

async function makeToken(orderId: string, tgId: bigint, action: Action): Promise<string> {
  const token = randomBytes(12).toString('hex')
  const value: Stored = { orderId, tgId: tgId.toString(), action }
  await redis.set(keyOf(token), JSON.stringify(value), 'EX', TOKEN_TTL_SECONDS)
  return `${PREFIX}${token}`
}

/** A button that opens the order inside the Telegram Mini App (no external-link prompt). */
function reviewButton(orderRef: string, text = '🔍 Review'): TgButton {
  const url = miniAppUrlAt(`/admin/gas/orders/${orderRef}`)
  return /^https:\/\//i.test(url) ? { text, web_app: { url } } : { text, url }
}

/**
 * The buttons that fit the order's state RIGHT NOW. Only actions that are valid are shown, and the
 * same rules are checked again when a button is tapped (a message can be hours old).
 */
export async function buildGasKeyboard(orderId: string, tgId: bigint): Promise<TgKeyboard> {
  const order = await db.gasFeeOrder.findUnique({
    where: { id: orderId },
    select: { orderRef: true, status: true, paymentCoin: true, paymentNetwork: true, retryCount: true, paymentTxHash: true, failureReason: true, deliveryTxHash: true, expiresAt: true },
  })
  if (!order) return []
  const review = reviewButton(order.orderRef)

  if (order.status === 'payment_uploaded' && isManualProofOrder(order) && order.expiresAt > new Date()) {
    return [
      [
        { text: '✅ Approve', callback_data: await makeToken(orderId, tgId, 'approve') },
        { text: '❌ Reject', callback_data: await makeToken(orderId, tgId, 'reject') },
      ],
      [review],
    ]
  }
  const stuck = order.status === 'payment_detected' && !!order.failureReason
  if (!order.deliveryTxHash && ((order.status === 'failed' && isPaidFailed({ ...order, failureReason: order.failureReason })) || stuck)) {
    return [[{ text: '🔁 Retry', callback_data: await makeToken(orderId, tgId, 'retry') }, review]]
  }
  return [[review]]
}

async function answer(id: string, text?: string, alert = false) {
  await telegramRequest('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}), show_alert: alert })
}

async function setKeyboard(chatId: number, messageId: number, rows: TgKeyboard) {
  await telegramRequest('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } })
}

const LABEL: Record<'approve' | 'reject' | 'retry', { yes: string; done: string; ask: string }> = {
  approve: { yes: '✅ Yes, approve and send gas', done: '✅ Approved', ask: 'Tap "Yes" to approve. Gas will be sent.' },
  reject: { yes: '❌ Yes, reject payment', done: '❌ Rejected', ask: 'Tap "Yes" to reject. Nothing will be sent.' },
  retry: { yes: '🔁 Yes, retry delivery', done: '🔁 Retry queued', ask: 'Tap "Yes" to retry the delivery.' },
}

/** Returns true when the callback belonged to this feature (so the caller stops looking). */
export async function handleGasCallback(cb: TgCallbackQuery): Promise<boolean> {
  if (!cb.data?.startsWith(PREFIX)) return false
  const msg = cb.message
  const token = cb.data.slice(PREFIX.length)
  if (!/^[a-f0-9]{24}$/.test(token) || !msg || msg.chat.type !== 'private' || msg.chat.id !== cb.from.id) {
    await answer(cb.id, 'This button is not valid.', true)
    return true
  }

  const raw = await redis.get(keyOf(token))
  if (!raw) { await answer(cb.id, 'This button expired. Open the order to continue.', true); return true }
  let stored: Stored
  try { stored = JSON.parse(raw) as Stored } catch { await answer(cb.id, 'This button is not valid.', true); return true }

  // The tap must come from the account the button was made for, and that account must be a current admin.
  const tgId = BigInt(cb.from.id)
  if (stored.tgId !== tgId.toString()) { await answer(cb.id, 'This button is not for you.', true); return true }
  const staff = await db.user.findUnique({ where: { telegramId: tgId }, select: { id: true, role: true, username: true } })
  if (!staff || (staff.role !== 'admin' && staff.role !== 'super_admin')) {
    logger.warn({ tgId: cb.from.id, orderId: stored.orderId }, 'Telegram gas action refused: not an admin')
    await answer(cb.id, 'You are not allowed to do this.', true)
    return true
  }

  const chatId = msg.chat.id
  const messageId = msg.message_id
  const refresh = async () => setKeyboard(chatId, messageId, await buildGasKeyboard(stored.orderId, tgId))

  if (stored.action === 'cancel') { await refresh(); await answer(cb.id, 'Cancelled.'); return true }

  // First tap: ask for the second one on the same message.
  if (stored.action === 'approve' || stored.action === 'reject' || stored.action === 'retry') {
    const order = await db.gasFeeOrder.findUnique({ where: { id: stored.orderId }, select: { orderRef: true } })
    if (!order) { await answer(cb.id, 'Order not found.', true); return true }
    const yes = await makeToken(stored.orderId, tgId, `yes_${stored.action}` as Action)
    const no = await makeToken(stored.orderId, tgId, 'cancel')
    await setKeyboard(chatId, messageId, [[{ text: LABEL[stored.action].yes, callback_data: yes }], [{ text: 'Cancel', callback_data: no }]])
    await answer(cb.id, LABEL[stored.action].ask)
    return true
  }

  // Second tap: run it once. The claim stops a repeated or replayed callback from running it again.
  const claimed = await redis.set(doneKeyOf(token), '1', 'EX', 3600, 'NX')
  if (claimed !== 'OK') { await answer(cb.id, 'Already handled.'); return true }

  const kind = stored.action.slice(4) as 'approve' | 'reject' | 'retry'
  const actor = { id: staff.id, via: 'telegram' as const }
  try {
    let note = ''
    if (kind === 'approve') { const r = await approveManualGasPayment(stored.orderId, actor); note = `${LABEL.approve.done}: gas delivery queued for ${r.orderRef}.` }
    else if (kind === 'reject') { const r = await rejectManualGasPayment(stored.orderId, REJECT_REASON, actor); note = `${LABEL.reject.done}: ${r.orderRef} closed, nothing sent.` }
    else { const r = await retryGasDelivery(stored.orderId, actor); note = r.message ? `ℹ️ ${r.message}` : `${LABEL.retry.done}.` }
    const stamp = new Date().toISOString().slice(11, 16)
    await telegramRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${msg.text ?? ''}\n\n${note}\nBy ${staff.username ?? 'admin'} at ${stamp} UTC`.slice(0, 4000),
      reply_markup: { inline_keyboard: await buildGasKeyboard(stored.orderId, tgId) },
      disable_web_page_preview: true,
    })
    await answer(cb.id, 'Done.')
  } catch (err) {
    // A refusal (already processed, expired, retry not proven safe…) is shown as a popup, and the message goes back to what is valid now.
    const text = err instanceof AppError ? err.message : 'Something went wrong. Open the order to check its status.'
    if (!(err instanceof AppError)) logger.error({ err, orderId: stored.orderId, kind }, 'Telegram gas action failed')
    await answer(cb.id, text, true)
    try { await refresh() } catch { /* keyboard refresh is best effort */ }
  }
  return true
}
