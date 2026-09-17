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
 * is a TradeEpisode marker inside the thread, spanning BOTH markets. A thread also
 * comes into existence when either side finds the other by username search and
 * starts a conversation directly (startThread) — trading together is no longer
 * required, so BlockedUser is the escape hatch for unwanted contact.
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
 * and posts a system divider. Never throws.
 *
 * NOT flag-gated (unlike openEpisode): an episode only exists if the flag was ON
 * when the trade opened, and closing one that exists is always cheap + correct.
 * Gating this on the flag was a bug — trades that completed while the flag was
 * OFF left their episode stuck at `active` forever, showing "In progress" in the
 * inbox even though the trade was long done. reconcileTradeEpisodes.ts backfills
 * the ones already stuck; keeping this ungated stops new ones from accruing
 * whenever the flag is toggled.
 */
export async function closeEpisode(params: {
  market: Market
  tradeId: string
  outcome: 'completed' | 'cancelled' | 'expired' | 'disputed' | 'dispute_resolved'
}): Promise<void> {
  try {
    const episode = await db.tradeEpisode.findUnique({
      where: { market_tradeId: { market: params.market, tradeId: params.tradeId } },
      select: { id: true, threadId: true, tradeRef: true, outcome: true },
    })
    if (!episode) return
    // 'disputed' is not strictly terminal, but we still surface it; don't overwrite
    // an already-finalized completed/cancelled/expired/dispute_resolved outcome.
    if (['completed', 'cancelled', 'expired', 'dispute_resolved'].includes(episode.outcome)) return
    await db.tradeEpisode.update({
      where: { id: episode.id },
      data: { outcome: params.outcome, endedAt: new Date() },
    })
    const label: Record<string, string> = {
      completed: 'completed', cancelled: 'cancelled', expired: 'expired', disputed: 'disputed', dispute_resolved: 'resolved',
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

/**
 * Undo a 'disputed' episode closure when the dispute is DISMISSED and the trade
 * hands back to its real in-progress rung — otherwise the inbox would show the
 * thread as permanently "Disputed" even though the trade resumed normally.
 * Only reopens from 'disputed'; never touches a genuinely terminal outcome.
 */
export async function reopenEpisode(params: { market: Market; tradeId: string }): Promise<void> {
  try {
    const episode = await db.tradeEpisode.findUnique({
      where: { market_tradeId: { market: params.market, tradeId: params.tradeId } },
      select: { id: true, threadId: true, tradeRef: true, outcome: true },
    })
    if (!episode || episode.outcome !== 'disputed') return
    await db.tradeEpisode.update({ where: { id: episode.id }, data: { outcome: 'active', endedAt: null } })
    // Narrate the resume the same way closeEpisode narrates a close — otherwise
    // the inbox timeline shows a "disputed" divider with no explanation of how
    // the trade got back to active.
    await db.chatThreadMessage.create({
      data: {
        threadId: episode.threadId,
        senderId: '',
        isSystem: true,
        body: `Trade ${episode.tradeRef} resumed — the dispute was dismissed.`,
      },
    })
    await db.chatThread.update({ where: { id: episode.threadId }, data: { lastMessageAt: new Date() } })
  } catch (err) {
    logger.warn({ err, tradeId: params.tradeId }, 'reopenEpisode failed (non-fatal)')
  }
}

// ─── User-facing reads/writes (routes) ───────────────────────────────────────

function assertParticipant(thread: { userAId: string; userBId: string }, userId: string): void {
  if (thread.userAId !== userId && thread.userBId !== userId) {
    throw new AppError('FORBIDDEN', 'Not a participant of this conversation', 403)
  }
}

/** True if either side has blocked the other. */
async function isBlockedEitherWay(aId: string, bId: string): Promise<boolean> {
  const hit = await db.blockedUser.findFirst({
    where: { OR: [{ blockerId: aId, blockedId: bId }, { blockerId: bId, blockedId: aId }] },
    select: { id: true },
  })
  return !!hit
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
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { senderId: true, body: true, isSystem: true, deliveredAt: true, readAt: true, createdAt: true } },
    },
  })

  // Loading the inbox is the recipient's device "seeing" the thread list — mark
  // every not-yet-delivered message the OTHER side sent as delivered now. Read
  // still requires actually opening the thread (getThread).
  const threadIds = threads.map((t) => t.id)
  if (threadIds.length) {
    await db.chatThreadMessage.updateMany({
      where: { threadId: { in: threadIds }, senderId: { not: userId }, isSystem: false, deliveredAt: null },
      data: { deliveredAt: new Date() },
    }).catch(() => {})
  }

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
      lastMessageStatus: last && last.senderId === userId
        ? (last.readAt ? 'read' : last.deliveredAt ? 'delivered' : 'sent')
        : null,
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

/**
 * Full thread view: messages + episode dividers + relationship stats.
 * `markRead` (default true) controls the per-message readAt receipt only —
 * pass false for a background poll while the tab isn't actually visible, so a
 * "Read" tick isn't shown for a message nobody has actually looked at yet.
 * Delivery (deliveredAt) and the thread-level unread flag are unaffected.
 */
export async function getThread(userId: string, threadId: string, markRead = true) {
  const thread = await db.chatThread.findUnique({
    where: { id: threadId },
    select: {
      id: true, userAId: true, userBId: true,
      userA: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      userB: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: 'asc' }, take: 500, select: { id: true, senderId: true, body: true, attachmentUrl: true, deletedAt: true, isSystem: true, deliveredAt: true, readAt: true, createdAt: true } },
      episodes: { orderBy: { startedAt: 'asc' }, select: { id: true, market: true, tradeId: true, tradeRef: true, outcome: true, fiatAmount: true, startedAt: true, endedAt: true } },
    },
  })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)

  // Mark read for this viewer — opening the thread means every message the
  // OTHER side sent has now been delivered AND seen (delivered may already be
  // set from an inbox-list fetch; read always follows from opening the thread).
  // These ticks are only ever shown to the SENDER on their own later fetch (see
  // receiptStatus below), which queries fresh from the DB — so there's nothing
  // to backfill into the response built from the pre-update `thread.messages`
  // read above.
  const isA = thread.userAId === userId
  const now = new Date()
  await Promise.all([
    db.chatThread.update({
      where: { id: threadId },
      data: isA ? { unreadByA: false } : { unreadByB: false },
    }),
    db.chatThreadMessage.updateMany({
      where: { threadId, senderId: { not: userId }, isSystem: false, deliveredAt: null },
      data: { deliveredAt: now },
    }),
    markRead
      ? db.chatThreadMessage.updateMany({
          where: { threadId, senderId: { not: userId }, isSystem: false, readAt: null },
          data: { readAt: now },
        })
      : Promise.resolve(null),
  ]).catch((err) => logger.warn({ err, threadId }, 'failed to mark thread read/delivered (non-fatal)'))

  const stats = { completed: 0, cancelled: 0, expired: 0, disputed: 0, active: 0, total: thread.episodes.length }
  const s = stats as Record<string, number>
  for (const e of thread.episodes) {
    // dispute_resolved folds into `completed` — same "done" bucket the rest of
    // the codebase uses for it (see reconcileTradeEpisodes.ts, CtmStatusTimeline).
    const key = e.outcome === 'dispute_resolved' ? 'completed' : e.outcome
    if (key in stats) s[key] = (s[key] ?? 0) + 1
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

  type Msg = { id: string; senderId: string; body: string; attachmentUrl: string | null; deletedAt: Date | null; isSystem: boolean; createdAt: Date; status: 'sent' | 'delivered' | 'read' | null }
  // Prefix trade-message ids so they can never collide with thread-message ids.
  // Only the thread's own messages support soft delete + delivery/read receipts;
  // folded trade-room lines never carry a deletedAt and have no receipt status.
  const receiptStatus = (senderId: string, deliveredAt: Date | null, readAt: Date | null): Msg['status'] =>
    senderId !== userId ? null : readAt ? 'read' : deliveredAt ? 'delivered' : 'sent'
  const messages: Msg[] = [
    ...thread.messages.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body, attachmentUrl: m.attachmentUrl, deletedAt: m.deletedAt, isSystem: m.isSystem, createdAt: m.createdAt, status: receiptStatus(m.senderId, m.deliveredAt, m.readAt) })),
    ...usdtMsgs.map((m) => ({ id: `tm_${m.id}`, senderId: m.senderId, body: m.message, attachmentUrl: m.attachmentUrl, deletedAt: null, isSystem: m.isSystem, createdAt: m.createdAt, status: null })),
    ...ctmMsgs.map((m) => ({ id: `cm_${m.id}`, senderId: m.senderId, body: m.message, attachmentUrl: m.attachmentUrl, deletedAt: null, isSystem: m.isSystem, createdAt: m.createdAt, status: null })),
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
  const [blockedByMe, blockedMe] = await Promise.all([
    db.blockedUser.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: other.id } }, select: { id: true } }),
    db.blockedUser.findUnique({ where: { blockerId_blockedId: { blockerId: other.id, blockedId: userId } }, select: { id: true } }),
  ])
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
    blockedByMe: !!blockedByMe,
    blockedMe: !!blockedMe,
  }
}

const MESSAGE_SELECT = { id: true, senderId: true, body: true, attachmentUrl: true, isSystem: true, createdAt: true } as const

/**
 * Post a message to a thread. Sender must be a participant. Bumps the other's
 * unread. `clientId` (optional) makes retried sends idempotent: the frontend's
 * auto-retry-on-failure reuses the same clientId, so a retry after a lost
 * response returns the original message instead of creating a duplicate.
 */
export async function postThreadMessage(userId: string, threadId: string, body: string, attachmentUrl?: string, clientId?: string) {
  const text = body.trim()
  if (!text && !attachmentUrl) throw new AppError('VALIDATION_ERROR', 'Message is empty', 400)
  if (text.length > 2000) throw new AppError('VALIDATION_ERROR', 'Message too long', 400)

  const thread = await db.chatThread.findUnique({ where: { id: threadId }, select: { id: true, userAId: true, userBId: true } })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)

  const otherId = thread.userAId === userId ? thread.userBId : thread.userAId
  if (await isBlockedEitherWay(userId, otherId)) {
    throw new AppError('FORBIDDEN', 'You can no longer message this person', 403)
  }

  // clientId is sent on every send, not just retries, so this must stay a
  // single round trip on the common path — attempt the create and only fall
  // back to a lookup on the rare unique-constraint hit (matches the same
  // create-then-catch-P2002 idempotency convention used by gas.ledger.ts).
  const isA = thread.userAId === userId
  try {
    const [message] = await db.$transaction([
      db.chatThreadMessage.create({
        data: { threadId, senderId: userId, body: text, clientId: clientId ?? null, ...(attachmentUrl ? { attachmentUrl } : {}) },
        select: MESSAGE_SELECT,
      }),
      db.chatThread.update({
        where: { id: threadId },
        // Bump the OTHER participant's unread flag.
        data: { lastMessageAt: new Date(), ...(isA ? { unreadByB: true } : { unreadByA: true }) },
      }),
    ])
    return message
  } catch (err) {
    // A retry of the same clientId (lost response, or a race between two
    // near-simultaneous retries) hits the unique constraint — return the
    // already-created row instead of failing or duplicating it.
    if (clientId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.chatThreadMessage.findUnique({ where: { threadId_clientId: { threadId, clientId } }, select: MESSAGE_SELECT })
      if (existing) return existing
    }
    throw err
  }
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

// ─── Username search + cold contact ──────────────────────────────────────────

/** Up to 10 users whose username OR display name matches, for the "find someone" search box. */
export async function searchUsers(userId: string, rawQuery: string) {
  const q = rawQuery.trim().replace(/^@/, '')
  if (q.length < 2) return []
  const [users, blockedEitherWay] = await Promise.all([
    db.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
        NOT: { id: userId },
        isBanned: false,
        isSuspended: false,
      },
      select: { id: true, username: true, fullName: true, avatarUrl: true },
      // Exact/prefix matches first, then alphabetical, so typing the full
      // handle reliably surfaces that one account first.
      orderBy: { username: 'asc' },
      take: 10,
    }),
    db.blockedUser.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    }),
  ])
  const blocked = new Set(blockedEitherWay.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)))
  return users.filter((u) => !blocked.has(u.id))
}

/**
 * Start (or resume) a conversation with any user by username — no shared trade
 * required. This is the intentional cold-DM path search enables; BlockedUser
 * is what lets either side shut it down afterward.
 */
export async function startThread(userId: string, targetUsername: string): Promise<{ threadId: string }> {
  const target = await db.user.findFirst({
    where: { username: { equals: targetUsername.trim().replace(/^@/, ''), mode: 'insensitive' } },
    select: { id: true },
  })
  if (!target) throw new AppError('NOT_FOUND', 'No user with that username', 404)
  if (target.id === userId) throw new AppError('VALIDATION_ERROR', "You can't message yourself", 400)
  if (await isBlockedEitherWay(userId, target.id)) {
    throw new AppError('FORBIDDEN', 'You can no longer message this person', 403)
  }
  const thread = await getOrCreateThread(userId, target.id)
  return { threadId: thread.id }
}

/** Block the OTHER participant of a thread — either side may initiate. Idempotent. */
export async function blockThreadUser(userId: string, threadId: string): Promise<void> {
  const thread = await db.chatThread.findUnique({ where: { id: threadId }, select: { userAId: true, userBId: true } })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)
  const otherId = thread.userAId === userId ? thread.userBId : thread.userAId
  await db.blockedUser.upsert({
    where: { blockerId_blockedId: { blockerId: userId, blockedId: otherId } },
    update: {},
    create: { blockerId: userId, blockedId: otherId },
  })
}

export async function unblockThreadUser(userId: string, threadId: string): Promise<void> {
  const thread = await db.chatThread.findUnique({ where: { id: threadId }, select: { userAId: true, userBId: true } })
  if (!thread) throw new AppError('NOT_FOUND', 'Conversation not found', 404)
  assertParticipant(thread, userId)
  const otherId = thread.userAId === userId ? thread.userBId : thread.userAId
  await db.blockedUser.deleteMany({ where: { blockerId: userId, blockedId: otherId } })
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
