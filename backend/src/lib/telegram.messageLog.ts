// Remembers the Telegram DMs we send about a trade / gas order and deletes them once that trade is
// CLEANLY finished. Only these DMs are ever touched: announcements, KYC / security notices, rank changes
// and every other message are never recorded here, so they are never deleted.
//
// A message is deleted only when ALL of these hold:
//   • the trade is in a clean final state: USDT crypto_released, CTM completed, gas order delivered
//     (disputed, pending, failed, cancelled, expired and refunded trades keep their messages);
//   • the trade never had a dispute (a dispute row keeps its history in Telegram);
//   • both the trade's completion AND the message itself are older than the configured delay;
//   • the message is younger than 47h — Telegram does not let a bot delete a private-chat message
//     older than 48h, so older rows are just forgotten.
// Every delete goes through telegramRequest(), so it shares the global rate limiter. The in-app
// bell notifications are NOT affected.
import { db } from './prisma'
import { logger } from './logger'
import { telegramRequest, type TgResult } from './telegram.client'
import {
  FLAGS,
  isFlagEnabled,
  getNumberConfig,
  TELEGRAM_CLEANUP_DELAY_MINUTES_KEY,
  TELEGRAM_CLEANUP_DELAY_MINUTES_DEFAULT,
} from '../services/platformFlags.service'

export type TelegramMessageKind = 'usdt' | 'ctm' | 'gas'
export interface TelegramMessageRef { kind: TelegramMessageKind; refKey: string }

/** Telegram refuses bot deletes after 48h; stop 1h early so a slow sweep never races the limit. */
const DELETE_WINDOW_MS = 47 * 60 * 60 * 1000
const MIN_DELAY_MINUTES = 5
const MAX_DELETES_PER_SWEEP = 200
const MAX_REFS_PER_SWEEP = 2000

/** Which trade a user notification belongs to, from its metadata. CTM trades carry `tradeRef`, USDT trades `tradeId`. */
export function refFromNotificationMetadata(metadata: Record<string, unknown>): TelegramMessageRef | null {
  if (typeof metadata.tradeRef === 'string' && metadata.tradeRef) return { kind: 'ctm', refKey: metadata.tradeRef }
  if (typeof metadata.tradeId === 'string' && metadata.tradeId) return { kind: 'usdt', refKey: metadata.tradeId }
  return null
}

function messageIdOf(result: TgResult): number | null {
  if (!result.ok) return null
  const id = (result.result as { message_id?: unknown } | undefined)?.message_id
  return typeof id === 'number' ? id : null
}

/** Remember a message we just sent so the sweep can delete it later. Never throws. */
export async function recordTelegramMessage(chatId: bigint, result: TgResult, ref: TelegramMessageRef | null): Promise<void> {
  if (!ref) return
  const messageId = messageIdOf(result)
  if (messageId === null) return
  try {
    await db.telegramSentMessage.create({ data: { chatId, messageId, kind: ref.kind, refKey: ref.refKey } })
  } catch (err) {
    logger.warn({ err, kind: ref.kind }, 'telegram message log: could not record message')
  }
}

/** Keys (per kind) whose trade is cleanly finished at least `before` ago and never had a dispute. */
async function finishedKeys(kind: TelegramMessageKind, keys: string[], before: Date): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  if (kind === 'usdt') {
    const rows = await db.trade.findMany({
      where: { id: { in: keys }, status: 'crypto_released', releasedAt: { lte: before }, dispute: null, disputeResumeStatus: null },
      select: { id: true },
    })
    return new Set(rows.map((r) => r.id))
  }
  if (kind === 'ctm') {
    const rows = await db.ctmTrade.findMany({
      where: { tradeRef: { in: keys }, status: 'completed', completedAt: { lte: before }, dispute: null, disputeResumeStatus: null },
      select: { tradeRef: true },
    })
    return new Set(rows.map((r) => r.tradeRef))
  }
  const rows = await db.gasFeeOrder.findMany({
    where: {
      id: { in: keys },
      status: 'delivered',
      OR: [{ deliveredAt: { lte: before } }, { deliveredAt: null, updatedAt: { lte: before } }],
    },
    select: { id: true },
  })
  return new Set(rows.map((r) => r.id))
}

/**
 * One sweep. Returns how many Telegram messages were deleted. Safe to run repeatedly; a failed delete just
 * leaves the row for the next tick (until the 47h window ends).
 */
export async function runTelegramMessageCleanup(now: Date = new Date()): Promise<number> {
  if (!(await isFlagEnabled(FLAGS.TELEGRAM_AUTO_CLEANUP, true))) return 0

  // Forget rows Telegram will no longer let us delete.
  const windowStart = new Date(now.getTime() - DELETE_WINDOW_MS)
  await db.telegramSentMessage.deleteMany({ where: { sentAt: { lt: windowStart } } })

  const delayMinutes = Math.max(MIN_DELAY_MINUTES, await getNumberConfig(TELEGRAM_CLEANUP_DELAY_MINUTES_KEY, TELEGRAM_CLEANUP_DELAY_MINUTES_DEFAULT))
  const before = new Date(now.getTime() - delayMinutes * 60_000)

  const refs = await db.telegramSentMessage.findMany({
    where: { sentAt: { lte: before } },
    distinct: ['kind', 'refKey'],
    select: { kind: true, refKey: true },
    take: MAX_REFS_PER_SWEEP,
  })
  if (refs.length === 0) return 0

  const byKind = new Map<TelegramMessageKind, string[]>()
  for (const r of refs) {
    const kind = r.kind as TelegramMessageKind
    byKind.set(kind, [...(byKind.get(kind) ?? []), r.refKey])
  }

  let deleted = 0
  for (const [kind, keys] of byKind) {
    const done = await finishedKeys(kind, keys, before)
    if (done.size === 0) continue

    const rows = await db.telegramSentMessage.findMany({
      where: { kind, refKey: { in: [...done] }, sentAt: { lte: before } },
      orderBy: { sentAt: 'asc' },
      take: MAX_DELETES_PER_SWEEP - deleted,
    })
    for (const row of rows) {
      const r = await telegramRequest('deleteMessage', { chat_id: row.chatId.toString(), message_id: row.messageId })
      // Rate-limited or throttled: stop here and pick the rest up on the next tick.
      if (r.throttledLocally || r.status === 429) return deleted
      // Deleted, user blocked the bot, or Telegram says it is already gone / too old (400): nothing left to do.
      if (r.ok || r.blocked || r.status === 400) {
        await db.telegramSentMessage.delete({ where: { id: row.id } }).catch(() => {})
        if (r.ok) deleted++
      }
      // Anything else (network error, 5xx): keep the row and retry next tick.
    }
    if (deleted >= MAX_DELETES_PER_SWEEP) break
  }
  if (deleted > 0) logger.info({ deleted }, 'telegram message cleanup: finished-trade messages deleted')
  return deleted
}
