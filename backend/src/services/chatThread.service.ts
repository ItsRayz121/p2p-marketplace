import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from './platformFlags.service'
import { logger } from '../lib/logger'

/**
 * Persistent counterparty messaging (Phase 4).
 *
 * One permanent ChatThread per unordered user pair (canonical userAId < userBId,
 * mirroring TradeStreak), reused across every trade the pair ever does. Each trade
 * is a TradeEpisode marker inside the thread, spanning BOTH markets. Trade-gated:
 * a thread only ever comes into existence via a real trade — there is no cold-DM
 * path. Once it exists the two established partners can keep chatting.
 *
 * Everything is gated by `messaging_inbox_enabled` (default OFF): while OFF, the
 * lifecycle hooks below no-op (no thread/episode writes at all) and the inbox is
 * hidden, so deploying changes nothing until a super-admin flips the flag.
 *
 * The lifecycle hooks (openEpisode/closeEpisode) are BEST-EFFORT and never throw —
 * a messaging failure must never break or roll back a trade.
 */

export type Market = 'usdt' | 'ctm'

/** Canonical ordering: the smaller id is always userA. */
function canonicalPair(x: string, y: string): { userAId: string; userBId: string } {
  return x < y ? { userAId: x, userBId: y } : { userAId: y, userBId: x }
}

/** Get or create the thread for a pair. Idempotent under concurrency (upsert). */
async function getOrCreateThread(x: string, y: string): Promise<{ id: string; userAId: string; userBId: string }> {
  const { userAId, userBId } = canonicalPair(x, y)
  const thread = await db.chatThread.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: {},
    create: { userAId, userBId },
    select: { id: true, userAId: true, userBId: true },
  })
  return thread
}

// ─── Lifecycle hooks (best-effort, called from trade services) ───────────────

/**
 * Record that a trade opened between two users: ensures the pair's thread exists,
 * creates the episode marker (idempotent on market+tradeId), and posts a system
 * divider line. No-op when the feature flag is OFF. Never throws.
 */
export async function openEpisode(params: {
  market: Market
  tradeId: string
  tradeRef: string
  buyerId: string
  sellerId: string
  fiatAmount?: Prisma.Decimal | number | string | null
}): Promise<void> {
  try {
    if (!(await isFlagEnabled(FLAGS.MESSAGING_INBOX))) return
    if (params.buyerId === params.sellerId) return
    const thread = await getOrCreateThread(params.buyerId, params.sellerId)
    const fiat = params.fiatAmount != null ? new Prisma.Decimal(params.fiatAmount) : null
    // Idempotent: unique (market, tradeId) means a retried open won't duplicate.
    const existing = await db.tradeEpisode.findUnique({
      where: { market_tradeId: { market: params.market, tradeId: params.tradeId } },
      select: { id: true },
    })
    if (existing) return
    await db.tradeEpisode.create({
      data: {
        threadId: thread.id,
        market: params.market,
        tradeId: params.tradeId,
        tradeRef: params.tradeRef,
        outcome: 'active',
        ...(fiat ? { fiatAmount: fiat } : {}),
      },
    })
    await db.chatThreadMessage.create({
      data: {
        threadId: thread.id,
        senderId: '',
        isSystem: true,
        body: `Trade ${params.tradeRef} opened.`,
      },
    })
    await db.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } })
  } catch (err) {
    logger.warn({ err, tradeId: params.tradeId }, 'openEpisode failed (non-fatal)')
  }
}

/**
 * Record a trade reaching a terminal state. Updates the episode outcome + endedAt
 * and posts a system divider. No-op when the flag is OFF. Never throws.
 */
export async function closeEpisode(params: {
  market: Market
  tradeId: string
  outcome: 'completed' | 'cancelled' | 'expired' | 'disputed'
}): Promise<void> {
  try {
    if (!(await isFlagEnabled(FLAGS.MESSAGING_INBOX))) return
    const episode = await db.tradeEpisode.findUnique({
      where: { market_tradeId: { market: params.market, tradeId: params.tradeId } },
      select: { id: true, threadId: true, tradeRef: true, outcome: true },
    })
    if (!episode) return
    // 'disputed' is not strictly terminal, but we still surface it; don't overwrite
    // an already-finalized completed/cancelled/expired outcome with 'disputed'.
    if (['completed', 'cancelled', 'expired'].includes(episode.outcome)) return
    await db.tradeEpisode.update({
      where: { id: episode.id },
      data: { outcome: params.outcome, endedAt: new Date() },
    })
    const label: Record<string, string> = {
      completed: 'completed', cancelled: 'cancelled', expired: 'expired', disputed: 'disputed',
    }
    await db.chatThreadMessage.create({
      data: {
        threadId: episode.threadId,
        senderId: '',
        isSystem: true,
        body: `Trade ${episode.tradeRef} ${label[params.outcome] ?? params.outcome}.`,
      },
    })
    await db.chatThread.update({ where: { id: episode.threadId }, data: { lastMessageAt: new Date() } })
  } catch (err) {
    logger.warn({ err, tradeId: params.tradeId }, 'closeEpisode failed (non-fatal)')
  }
}

// ─── User-facing reads/writes (routes) ───────────────────────────────────────

function assertParticipant(thread: { userAId: string; userBId: string }, userId: string): void {
  if (thread.userAId !== userId && thread.userBId !== userId) {
    throw new AppError('FORBIDDEN', 'Not a participant of this conversation', 403)
  }
}

/** Inbox: the user's threads, newest activity first, with unread + active-trade counts. */
export async function getInbox(userId: string) {
  const threads = await db.chatThread.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    select: {
      id: true, userAId: true, userBId: true, lastMessageAt: true, unreadByA: true, unreadByB: true,
      userA: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      userB: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      episodes: { select: { outcome: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, isSystem: true, createdAt: true } },
    },
  })
  return threads.map((t) => {
    const isA = t.userAId === userId
    const other = isA ? t.userB : t.userA
    const unread = isA ? t.unreadByA : t.unreadByB
    const activeTrades = t.episodes.filter((e) => e.outcome === 'active').length
    const last = t.messages[0]
    return {
      threadId: t.id,
      other,
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: last ? last.body : null,
      unread,
      activeTrades,
      totalTrades: t.episodes.length,
    }
  })
}

/** Total active-trade episodes across all the user's threads (dropdown badge). */
export async function getInboxSummary(userId: string): Promise<{ unreadThreads: number; activeTrades: number }> {
  const threads = await db.chatThread.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, unreadByA: true, unreadByB: true, episodes: { select: { outcome: true } } },
  })
  let unreadThreads = 0
  let activeTrades = 0
  for (const t of threads) {
    const unread = t.userAId === userId ? t.unreadByA : t.unreadByB
    if (unread) unreadThreads++
    activeTrades += t.episodes.filter((e) => e.outcome === 'active').length
  }
  return { unreadThreads, activeTrades }
}

/** Full thread view: messages + episode dividers + relationship stats. Marks read. */
export async function getThread(userId: string, threadId: string) {
  const thread = await db.chatThread.findUnique({
    where: { id: threadId },
    select: {
      id: true, userAId: true, userBId: true,
      userA: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      userB: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 500, select: { id: true, senderId: true, body: true, attachmentUrl: true, deletedAt: true, isSystem: true, createdAt: true } },
      episodes: { orderBy: { startedAt: 'asc' }, select: { id: true, market: true, tradeId: true, tradeRef: true, outcome: true, fiatAmount: true, startedAt: true, endedAt: true } },
    },
  })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)

  // Mark read for this viewer.
  const isA = thread.userAId === userId
  await db.chatThread.update({
    where: { id: threadId },
    data: isA ? { unreadByA: false } : { unreadByB: false },
  }).catch(() => {})

  const stats = { completed: 0, cancelled: 0, expired: 0, disputed: 0, active: 0, total: thread.episodes.length }
  const s = stats as Record<string, number>
  for (const e of thread.episodes) {
    if (e.outcome in stats) s[e.outcome] = (s[e.outcome] ?? 0) + 1
  }

  // ── Unify the timeline: the actual per-trade room chat still lives in
  //    TradeMessage / CtmTradeMessage (source of truth for a trade, untouched).
  //    The inbox is a UNION VIEW that folds each episode's real messages into
  //    the thread's own free-chat messages, so a line typed in the trade room
  //    shows up here too. Trade *system* step-lines are excluded — the episode
  //    dividers already convey lifecycle, and including them would bury the
  //    actual conversation under 6+ status lines per trade.
  const usdtTradeIds = thread.episodes.filter((e) => e.market === 'usdt').map((e) => e.tradeId)
  const ctmTradeIds = thread.episodes.filter((e) => e.market === 'ctm').map((e) => e.tradeId)
  const [usdtMsgs, ctmMsgs] = await Promise.all([
    usdtTradeIds.length
      ? db.tradeMessage.findMany({
          where: { tradeId: { in: usdtTradeIds }, isSystem: false },
          select: { id: true, senderId: true, message: true, attachmentUrl: true, isSystem: true, createdAt: true },
        })
      : Promise.resolve([]),
    ctmTradeIds.length
      ? db.ctmTradeMessage.findMany({
          where: { tradeId: { in: ctmTradeIds }, isSystem: false },
          select: { id: true, senderId: true, message: true, attachmentUrl: true, isSystem: true, createdAt: true },
        })
      : Promise.resolve([]),
  ])

  type Msg = { id: string; senderId: string; body: string; attachmentUrl: string | null; deletedAt: Date | null; isSystem: boolean; createdAt: Date }
  // Prefix trade-message ids so they can never collide with thread-message ids.
  // Only the thread's own messages support soft delete; folded trade-room lines
  // never carry a deletedAt.
  const messages: Msg[] = [
    ...thread.messages.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body, attachmentUrl: m.attachmentUrl, deletedAt: m.deletedAt, isSystem: m.isSystem, createdAt: m.createdAt })),
    ...usdtMsgs.map((m) => ({ id: `tm_${m.id}`, senderId: m.senderId, body: m.message, attachmentUrl: m.attachmentUrl, deletedAt: null, isSystem: m.isSystem, createdAt: m.createdAt })),
    ...ctmMsgs.map((m) => ({ id: `cm_${m.id}`, senderId: m.senderId, body: m.message, attachmentUrl: m.attachmentUrl, deletedAt: null, isSystem: m.isSystem, createdAt: m.createdAt })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    // Redact retracted messages to a tombstone in the inbox view (the row itself
    // is retained in the DB for dispute review).
    .map((m) => (m.deletedAt ? { ...m, body: '', attachmentUrl: null } : m))

  // Live status for ACTIVE episodes so the thread can show a progress bar (H1).
  // The episode's own `outcome` stays 'active' the whole time, so we join to the
  // real trade for its granular status. Bounded — usually 0–1 active per thread.
  const activeUsdtIds = thread.episodes.filter((e) => e.market === 'usdt' && e.outcome === 'active').map((e) => e.tradeId)
  const activeCtmIds = thread.episodes.filter((e) => e.market === 'ctm' && e.outcome === 'active').map((e) => e.tradeId)
  const [uStatuses, cStatuses] = await Promise.all([
    activeUsdtIds.length ? db.trade.findMany({ where: { id: { in: activeUsdtIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
    activeCtmIds.length ? db.ctmTrade.findMany({ where: { id: { in: activeCtmIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
  ])
  const statusByTrade = new Map<string, string>()
  for (const t of [...uStatuses, ...cStatuses]) statusByTrade.set(t.id, t.status)

  // Whether THIS viewer has already rated each completed trade — lets the inbox
  // hide the "Rate this trade" prompt once a rating is in (H2). Only completed
  // episodes can be rated, so we scope the lookup to them.
  const completedUsdtIds = thread.episodes.filter((e) => e.market === 'usdt' && e.outcome === 'completed').map((e) => e.tradeId)
  const completedCtmIds = thread.episodes.filter((e) => e.market === 'ctm' && e.outcome === 'completed').map((e) => e.tradeId)
  const [uRatings, cRatings] = await Promise.all([
    completedUsdtIds.length ? db.tradeRating.findMany({ where: { tradeId: { in: completedUsdtIds }, ratedByUserId: userId }, select: { tradeId: true } }) : Promise.resolve([]),
    completedCtmIds.length ? db.ctmTradeRating.findMany({ where: { tradeId: { in: completedCtmIds }, ratedByUserId: userId }, select: { tradeId: true } }) : Promise.resolve([]),
  ])
  const ratedByMe = new Set<string>([...uRatings, ...cRatings].map((r) => r.tradeId))

  const other = isA ? thread.userB : thread.userA
  return {
    threadId: thread.id,
    other,
    stats,
    episodes: thread.episodes.map((e) => ({
      ...e,
      fiatAmount: e.fiatAmount ? e.fiatAmount.toString() : null,
      status: e.outcome === 'active' ? (statusByTrade.get(e.tradeId) ?? null) : null,
      ratedByMe: e.outcome === 'completed' ? ratedByMe.has(e.tradeId) : false,
    })),
    messages,
  }
}

/** Post a message to a thread. Sender must be a participant. Bumps the other's unread. */
export async function postThreadMessage(userId: string, threadId: string, body: string, attachmentUrl?: string) {
  const text = body.trim()
  if (!text && !attachmentUrl) throw new AppError('VALIDATION_ERROR', 'Message is empty', 400)
  if (text.length > 2000) throw new AppError('VALIDATION_ERROR', 'Message too long', 400)

  const thread = await db.chatThread.findUnique({ where: { id: threadId }, select: { id: true, userAId: true, userBId: true } })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)

  const isA = thread.userAId === userId
  const [message] = await db.$transaction([
    db.chatThreadMessage.create({
      data: { threadId, senderId: userId, body: text, ...(attachmentUrl ? { attachmentUrl } : {}) },
      select: { id: true, senderId: true, body: true, attachmentUrl: true, isSystem: true, createdAt: true },
    }),
    db.chatThread.update({
      where: { id: threadId },
      // Bump the OTHER participant's unread flag.
      data: { lastMessageAt: new Date(), ...(isA ? { unreadByB: true } : { unreadByA: true }) },
    }),
  ])
  return message
}

// Retraction is only allowed within this window of sending (matches the support
// chat). The original row is retained for dispute review regardless.
const MESSAGE_DELETE_WINDOW_MS = 15 * 60 * 1000

/**
 * Soft-delete (retract) one of the viewer's own thread messages. Only the
 * thread's own free-chat messages are deletable — folded trade-room lines (ids
 * prefixed tm_/cm_) and the counterparty's messages are not. The row is retained
 * for dispute review; the inbox renders a tombstone in its place.
 */
export async function deleteThreadMessage(userId: string, threadId: string, messageId: string) {
  // Folded trade-room messages carry a prefix and live in another table — never
  // retractable from the inbox.
  if (messageId.startsWith('tm_') || messageId.startsWith('cm_')) {
    throw new AppError('NOT_FOUND', 'Message not found', 404)
  }
  const message = await db.chatThreadMessage.findUnique({
    where: { id: messageId },
    select: { id: true, threadId: true, senderId: true, isSystem: true, deletedAt: true, createdAt: true },
  })
  if (!message || message.threadId !== threadId || message.senderId !== userId || message.isSystem) {
    throw new AppError('NOT_FOUND', 'Message not found', 404)
  }
  if (message.deletedAt) return { ok: true } // idempotent
  if (Date.now() - message.createdAt.getTime() > MESSAGE_DELETE_WINDOW_MS) {
    throw new AppError('VALIDATION_ERROR', 'Messages can only be deleted within 15 minutes of sending.', 400)
  }
  await db.chatThreadMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } })
  return { ok: true }
}

/**
 * Best-effort hook: a real per-trade room message was just posted, so bump the
 * pair's inbox thread (lastMessageAt + the recipient's unread) to keep the inbox
 * ordering/unread accurate — the trade message itself stays in TradeMessage /
 * CtmTradeMessage and is folded into the thread view by getThread(). No-op while
 * the inbox flag is OFF; never throws (a messaging failure must not break chat).
 */
export async function bumpThreadForTradeMessage(params: {
  buyerId: string
  sellerId: string
  senderId: string
}): Promise<void> {
  try {
    if (!(await isFlagEnabled(FLAGS.MESSAGING_INBOX))) return
    if (params.buyerId === params.sellerId) return
    const thread = await getOrCreateThread(params.buyerId, params.sellerId)
    const senderIsA = params.senderId === thread.userAId
    await db.chatThread.update({
      where: { id: thread.id },
      // Bump the recipient's unread flag (the participant who is NOT the sender).
      data: { lastMessageAt: new Date(), ...(senderIsA ? { unreadByB: true } : { unreadByA: true }) },
    })
  } catch (err) {
    logger.warn({ err, senderId: params.senderId }, 'bumpThreadForTradeMessage failed (non-fatal)')
  }
}
