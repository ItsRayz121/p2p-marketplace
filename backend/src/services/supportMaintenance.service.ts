import { db } from '../lib/prisma'

export interface MergeResult {
  usersMerged: number
  rowsDeleted: number
}

/**
 * Collapse every user's multiple support conversations into a single "box".
 *
 * Before the one-conversation-per-user fix, each auto-close spawned a fresh
 * SupportConversation on the user's next message. This re-points all of a user's
 * messages onto their OLDEST conversation and deletes the extras, so their whole
 * history lives in one thread (sessions are separated by in-thread dividers).
 *
 * Idempotent: a user with a single conversation is left untouched. Shared by the
 * `support:merge-conversations` script and the super-admin admin button.
 */
export async function mergeDuplicateSupportConversations(
  onLog?: (msg: string) => void,
): Promise<MergeResult> {
  const conversations = await db.supportConversation.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      userId: true,
      status: true,
      lastMessageAt: true,
      unreadByAdmin: true,
      unreadByUser: true,
    },
  })

  const byUser = new Map<string, typeof conversations>()
  for (const c of conversations) {
    const list = byUser.get(c.userId) ?? []
    list.push(c)
    byUser.set(c.userId, list)
  }

  let usersMerged = 0
  let rowsDeleted = 0

  for (const [userId, list] of byUser) {
    if (list.length < 2) continue

    const [canonical, ...dupes] = list // oldest is canonical
    if (!canonical) continue
    const dupeIds = dupes.map((d) => d.id)

    const latest = list.reduce((a, b) => (a.lastMessageAt > b.lastMessageAt ? a : b))

    await db.$transaction([
      db.supportMessage.updateMany({
        where: { conversationId: { in: dupeIds } },
        data: { conversationId: canonical.id },
      }),
      db.supportConversation.update({
        where: { id: canonical.id },
        data: {
          status: latest.status,
          lastMessageAt: latest.lastMessageAt,
          unreadByAdmin: list.some((c) => c.unreadByAdmin),
          unreadByUser: list.some((c) => c.unreadByUser),
        },
      }),
      db.supportConversation.deleteMany({ where: { id: { in: dupeIds } } }),
    ])

    usersMerged += 1
    rowsDeleted += dupeIds.length
    onLog?.(`user ${userId}: merged ${list.length} conversations → 1 (removed ${dupeIds.length})`)
  }

  return { usersMerged, rowsDeleted }
}
