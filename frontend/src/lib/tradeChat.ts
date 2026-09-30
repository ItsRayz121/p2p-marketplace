/**
 * Single source of truth for how a trade-room message is presented, shared by the
 * 1:1 Messages thread and both trade rooms (USDT + CTM).
 *
 * Trade lifecycle lines are stored as `isSystem` messages whose senderId is the
 * participant who triggered the step. They fall into two groups:
 *  - participant events ("Seller marked 2 USDT as sent", "Payment proof uploaded")
 *    → rendered as a bubble on the ACTOR's side, relative to the current viewer;
 *  - neutral notices (trade created/complete/cancelled, dispute, streak milestone,
 *    reminders, review prompt) → rendered as their own compact centered line.
 */

export type TradeMessagePresentation =
  | { kind: 'message'; mine: boolean }
  | { kind: 'event'; mine: boolean; senderName: string }
  | { kind: 'notice' }

interface ClassifiableMessage {
  senderId: string
  isSystem?: boolean
  body: string
}

/** Wording that describes the trade as a whole rather than one participant's action. */
const NEUTRAL_NOTICE_PATTERNS: readonly RegExp[] = [
  /^Trade\b/i,                              // created / started / opened / resumed / cancelled / complete / auto-completed
  /^A dispute was opened/i,
  /^Dispute\b/i,
  /completed trade (between you two|together)/i, // 2nd completed trade… / 🔥 Milestone! …
  /Enjoyed trading here/i,                  // review prompt
  /^Merchant[’']s terms/i,
  /^(Reminder:|⏰)/,
]

export function isNeutralTradeNotice(body: string): boolean {
  const text = body.trim()
  return NEUTRAL_NOTICE_PATTERNS.some((re) => re.test(text))
}

/**
 * @param viewerId      the logged-in user
 * @param participants  senderId → display name for the real traders in this room
 *                      (a senderId outside this map — '' or an admin — is neutral)
 */
export function presentTradeMessage(
  msg: ClassifiableMessage,
  viewerId: string | null | undefined,
  participants: Record<string, string>,
): TradeMessagePresentation {
  const mine = !!viewerId && msg.senderId === viewerId
  if (!msg.isSystem) return { kind: 'message', mine }
  if (!msg.senderId || !(msg.senderId in participants)) return { kind: 'notice' }
  if (isNeutralTradeNotice(msg.body)) return { kind: 'notice' }
  return { kind: 'event', mine, senderName: mine ? 'You' : participants[msg.senderId]! }
}
