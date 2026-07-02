import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

// A support conversation is auto-closed once it has been idle (no new message
// from either side) for this many minutes. The frontend uses the SAME threshold
// to draw session dividers, so the visible "Chat closed" marker lines up with
// the real backend close. Keep the two in sync if you ever change this.
export const SUPPORT_IDLE_CLOSE_MINUTES = 10

/**
 * Idle-close sweep: flip any `open` support conversation whose last message is
 * older than SUPPORT_IDLE_CLOSE_MINUTES to `closed`. The next user message
 * reopens the same conversation (POST /support/chat/messages sets status:'open'),
 * so history stays in one continuous thread — the close is what starts a fresh
 * session divider on both the widget and the admin inbox.
 */
export async function runSupportIdleClose(): Promise<void> {
  const cutoff = new Date(Date.now() - SUPPORT_IDLE_CLOSE_MINUTES * 60_000)
  const res = await db.supportConversation.updateMany({
    where: { status: 'open', lastMessageAt: { lt: cutoff } },
    data: { status: 'closed' },
  })
  if (res.count > 0) {
    logger.debug({ closed: res.count }, 'Support idle-close sweep')
  }
}
