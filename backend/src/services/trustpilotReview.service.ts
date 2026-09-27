import { db } from '../lib/prisma'
import { sseEmit } from '../lib/sse'
import { notify } from '../lib/notify'
import { TRUSTPILOT_CHAT_NUDGE_ENABLED } from '../lib/tradeMessages'

export const REVIEW_NUDGE_BODY =
  '⭐ Enjoyed trading with us? Leave RupChain a quick review on Trustpilot — it takes 30 seconds and helps other traders in Pakistan find a platform they can trust.'

/**
 * Fires after a genuine completed trade/order (USDT trade, CTM trade, or delivered
 * gas order) — never on a failed/cancelled one, since callers only invoke this from
 * their completion path. No-ops permanently once the user self-reports a review
 * (User.trustpilotReviewedAt). Posts a bell notification AND a message into the
 * user's "RupChain Official" support thread (pinned at the top of Messages), so the
 * ask shows in both surfaces until reviewed — matching the on-page nudge that
 * already exists on trade/gas completion screens.
 *
 * Best-effort: never throws into the caller's completion flow.
 */
export async function maybeSendTrustpilotReviewNudge(userId: string): Promise<void> {
  if (!TRUSTPILOT_CHAT_NUDGE_ENABLED) return
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { trustpilotReviewedAt: true } })
    if (!user || user.trustpilotReviewedAt) return

    let conversation = await db.supportConversation.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (!conversation) conversation = await db.supportConversation.create({ data: { userId } })

    // Don't stack a second nudge on top of one that's still sitting unanswered.
    const lastNudge = await db.supportMessage.findFirst({
      where: { conversationId: conversation.id, kind: 'review_nudge' },
      orderBy: { createdAt: 'desc' },
    })
    if (lastNudge) {
      const ack = await db.supportMessage.findFirst({
        where: { conversationId: conversation.id, kind: 'review_ack', createdAt: { gt: lastNudge.createdAt } },
      })
      if (!ack) return
    }

    const message = await db.supportMessage.create({
      data: { conversationId: conversation.id, sender: 'system', kind: 'review_nudge', body: REVIEW_NUDGE_BODY },
    })
    await db.supportConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadByUser: true, status: 'open' },
    })

    sseEmit(userId, {
      type: 'support_message',
      payload: {
        scope: 'user',
        conversationId: conversation.id,
        message: {
          id: message.id, sender: message.sender, body: message.body, kind: message.kind,
          metadata: message.metadata, rating: message.rating, createdAt: message.createdAt,
        },
      },
    })

    notify(
      userId, 'review', 'Enjoyed trading with us?',
      'Leave RupChain a quick review on Trustpilot — tap to rate.',
      { kind: 'trustpilot_review_nudge' },
      undefined, '/messages/support', { silent: true },
    )
  } catch {
    /* best-effort — never let a review nudge break a trade/order completion */
  }
}
