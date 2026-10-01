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
  | { kind: 'event'; mine: boolean; senderName: string; text: string }
  | { kind: 'notice'; tone: TradeNoticeTone; text: string }

export type TradeNoticeTone = 'success' | 'milestone' | 'review' | 'warning' | 'danger' | 'info'

/**
 * Lifecycle lines are stored once, worded from the actor's side ("Seller marked…").
 * Re-voice them per viewer so the two traders read a natural exchange: the actor
 * sees first person ("I've sent…"), the counterparty sees who did what.
 */
const EVENT_REWRITES: ReadonlyArray<{
  re: RegExp
  mine: (m: RegExpMatchArray) => string
  theirs: (m: RegExpMatchArray) => string
  /** Only the leading phrase is replaced; the rest of the stored text (e.g. the reason) is kept. */
  keepTail?: boolean
}> = [
  {
    re: /^Seller marked (.+?) as sent\./i,
    mine: (m) => `I've sent ${m[1]}. Please confirm once it arrives in your wallet/account.`,
    theirs: (m) => `Seller has sent ${m[1]}. Please confirm once it arrives in your wallet/account.`,
  },
  {
    re: /^Payment proof uploaded\./i,
    mine: () => "I've uploaded the payment proof. Please confirm once you've received the payment.",
    theirs: () => 'Buyer has uploaded the payment proof. Please verify it and confirm once the payment is received.',
  },
  {
    re: /^Seller confirmed the PKR payment was received\./i,
    mine: () => "I've confirmed the PKR payment. I'll send the crypto now.",
    theirs: () => 'Seller has confirmed your PKR payment and will now send the crypto.',
  },
  {
    re: /^Buyer confirmed the crypto was received\./i,
    mine: () => "I've received the crypto. I'll send the PKR payment and upload the proof shortly.",
    theirs: () => 'Buyer has confirmed receiving the crypto and will now send the PKR payment and upload the proof.',
  },
  {
    re: /^Seller rejected the payment proof/i,
    mine: () => 'I rejected the payment proof',
    theirs: () => 'Seller rejected the payment proof',
    keepTail: true,
  },
]

function rewriteTradeEvent(body: string, mine: boolean): string {
  const text = body.trim()
  for (const r of EVENT_REWRITES) {
    const m = text.match(r.re)
    if (!m) continue
    const rest = text.slice(m[0].length)
    return (mine ? r.mine(m) : r.theirs(m)) + (r.keepTail ? rest : '')
  }
  return text
}

const EMOJI_EDGES = /^[\p{Extended_Pictographic}\p{Variation_Selector}\p{Join_Control}\s]+|[\p{Extended_Pictographic}\p{Variation_Selector}\p{Join_Control}\s]+$/gu

function noticeTone(body: string): TradeNoticeTone {
  if (/^Trade complete|^Dispute closed/i.test(body)) return 'success'
  if (/completed trade (between you two|together)|Milestone/i.test(body)) return 'milestone'
  if (/Enjoyed trading here/i.test(body)) return 'review'
  if (/^A dispute was opened|^Dispute\b/i.test(body)) return 'danger'
  if (/cancel/i.test(body)) return 'danger'
  if (/^(Reminder:|⏰)|Final warning/i.test(body)) return 'warning'
  return 'info'
}

/** Drops decorative leading/trailing emoji — the notice renders its own icon. */
function cleanNoticeText(body: string): string {
  return body.replace(EMOJI_EDGES, '')
}

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
  const notice = (): TradeMessagePresentation => ({ kind: 'notice', tone: noticeTone(msg.body.trim()), text: cleanNoticeText(msg.body) })
  if (!msg.senderId || !(msg.senderId in participants)) return notice()
  if (isNeutralTradeNotice(msg.body)) return notice()
  return { kind: 'event', mine, senderName: mine ? 'You' : participants[msg.senderId]!, text: rewriteTradeEvent(msg.body, mine) }
}
