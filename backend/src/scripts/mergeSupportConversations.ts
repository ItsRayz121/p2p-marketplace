/**
 * One-shot backfill: collapse every user's multiple support conversations into a
 * single "box".
 *
 * Before the one-conversation-per-user fix, each auto-close spawned a fresh
 * SupportConversation row on the user's next message — so a returning user
 * showed up as several inbox entries. This script re-points all of a user's
 * messages onto their OLDEST conversation and deletes the extras, so their whole
 * history lives in one thread (sessions are separated by the in-thread dividers).
 *
 * Idempotent: a user with a single conversation is left untouched.
 *
 * Usage:
 *   npx tsx src/scripts/mergeSupportConversations.ts
 */

import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'

async function main() {
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

  // Group by user, preserving createdAt-ascending order.
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

    // The merged thread reflects the most recent activity across all sessions.
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
    console.log(`  user ${userId}: merged ${list.length} conversations → 1 (removed ${dupeIds.length})`)
  }

  console.log(
    `Merge complete — ${usersMerged} user(s) consolidated, ${rowsDeleted} duplicate conversation row(s) removed.`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
