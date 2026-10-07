import { db } from '../lib/prisma'
import { sseEmit } from '../lib/sse'

export const GAS_OFFER_BODY =
  '⛽ Need gas to move your USDT? Top up BNB, TRX, ETH and more in minutes. You can pay in PKR or USDT, from an exchange or straight from a wallet. Tip: spend your RupChain Points on gas-fee discounts in Points → Shop.'

const MIN_GAP_MS = 7 * 86_400_000

/**
 * After a completed USDT or CTM trade, drop a short "need gas?" offer into the user's
 * "RupChain Official" inbox thread (no bell/push, so it never feels spammy). At most one
 * every 7 days per user. Best-effort: never throws into the trade-completion flow.
 */
export async function maybeSendGasOfferNudge(userId: string): Promise<void> {
  try {
    let conversation = await db.supportConversation.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    if (!conversation) conversation = await db.supportConversation.create({ data: { userId } })

    const last = await db.supportMessage.findFirst({
      where: { conversationId: conversation.id, kind: 'gas_offer' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (last && Date.now() - last.createdAt.getTime() < MIN_GAP_MS) return

    const message = await db.supportMessage.create({
      data: { conversationId: conversation.id, sender: 'system', kind: 'gas_offer', body: GAS_OFFER_BODY },
    })
    await db.supportConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadByUser: true },
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
  } catch {
    /* best-effort */
  }
}
