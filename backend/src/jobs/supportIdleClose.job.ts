import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

// A support conversation is auto-closed once it has been idle (no new message
// from either side) for this many minutes. The frontend uses the SAME threshold
// to draw session dividers, so the visible "Chat closed" marker lines up with
// the real backend close. Keep the two in sync if you ever change this.
export const SUPPORT_IDLE_CLOSE_MINUTES = 10

/**
 * Idle-close sweep: flip an `open` support conversation to `closed` once it has
 * been idle past SUPPORT_IDLE_CLOSE_MINUTES — but ONLY when we're waiting on the
 * user (the last message was ours: admin or a system note). A conversation whose
 * last message is from the USER is awaiting an admin reply and must NEVER be
 * auto-closed, so a pending question is never lost.
 *
 * The next user message reopens the same conversation (POST /support/chat/messages
 * sets status:'open'), so history stays in one continuous thread — the close is
 * what starts a fresh session divider on both the widget and the admin inbox.
 */
export async function runSupportIdleClose(): Promise<void> {
  const cutoff = new Date(Date.now() - SUPPORT_IDLE_CLOSE_MINUTES * 60_000)
  const candidates = await db.supportConversation.findMany({
    where: { status: 'open', lastMessageAt: { lt: cutoff } },
    select: { id: true, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { sender: true } } },
  })

  // Only close chats whose last word was ours — i.e. we're waiting on the user.
  const toClose = candidates
    .filter((c) => {
      const lastSender = c.messages[0]?.sender
      return lastSender === 'admin' || lastSender === 'system'
    })
    .map((c) => c.id)

  if (toClose.length === 0) return

  const res = await db.supportConversation.updateMany({
    where: { id: { in: toClose }, status: 'open' },
    data: { status: 'closed' },
  })
  if (res.count > 0) {
    logger.debug({ closed: res.count }, 'Support idle-close sweep (awaiting-user only)')
  }
}
