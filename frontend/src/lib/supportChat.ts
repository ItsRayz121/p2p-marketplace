// Client helpers for the in-app live support chat.
// The floating widget (SupportChatWidget) listens for the custom event below
// so any page can open the chat via openSupportChat().

import { apiRequest } from '@/lib/api'

export const SUPPORT_CHAT_OPEN_EVENT = 'rupchain:open-support-chat'

/** Open the floating support chat widget from anywhere in the app. */
export function openSupportChat(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SUPPORT_CHAT_OPEN_EVENT))
}

export interface SupportMessage {
  id: string
  sender: 'user' | 'admin' | 'system'
  body: string
  /** Optional image attachment (Cloudinary URL). Null when redacted (deleted) or absent. */
  attachmentUrl?: string | null
  /** Set when the message was retracted — the client renders a tombstone. */
  deletedAt?: string | null
  rating?: number | null
  // Structured messages: 'refund_request' renders a refund-destination form for the
  // user; 'refund_response' is their submitted answer. Plain chat omits kind ('text').
  kind?: 'text' | 'refund_request' | 'refund_response'
  metadata?: Record<string, unknown> | null
  createdAt: string
}

// USDT rails a user may pick when submitting a refund address.
export const REFUND_NETWORKS = ['BEP20', 'ERC20', 'TRC20', 'APTOS'] as const
export type RefundNetwork = (typeof REFUND_NETWORKS)[number]

export interface SupportChatState {
  conversation: { id: string; status: string; unreadByUser: boolean; lastMessageAt: string } | null
  messages: SupportMessage[]
}

// Satisfaction rating display: 1=bad, 2=okay, 3=great.
export const SUPPORT_RATINGS: { score: number; emoji: string; label: string }[] = [
  { score: 1, emoji: '😞', label: 'Bad' },
  { score: 2, emoji: '😐', label: 'Okay' },
  { score: 3, emoji: '😊', label: 'Great' },
]

// Must match SUPPORT_IDLE_CLOSE_MINUTES in the backend idle-close job so the
// visible session dividers line up with the real backend auto-close.
export const SUPPORT_IDLE_CLOSE_MINUTES = 10

export type ChatTimelineItem<M> =
  | { kind: 'day'; at: string; key: string }
  | { kind: 'session'; at: string; key: string }
  | { kind: 'closed'; at: string; key: string }
  | { kind: 'message'; msg: M; key: string }

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Turn a flat, ascending-by-time message list into a render timeline with
 * session boundaries. Rules:
 *  - a date header opens the very first message and any calendar-day change;
 *  - a gap larger than the idle threshold ends the previous session (a "closed"
 *    marker) and opens a new one (a "session" time marker);
 *  - if the conversation is currently `closed`, a trailing "closed" marker is
 *    added after the last message.
 * The whole history stays in one continuous thread — dividers just distinguish
 * each chat by date/time.
 */
export function buildChatTimeline<M extends { id: string; createdAt: string; sender?: string }>(
  messages: M[],
  opts?: { status?: string; idleMinutes?: number },
): ChatTimelineItem<M>[] {
  const idleMs = (opts?.idleMinutes ?? SUPPORT_IDLE_CLOSE_MINUTES) * 60_000
  const items: ChatTimelineItem<M>[] = []
  // `prevReal` drives session/day boundaries (system notes/ratings don't count);
  // `lastAnyAt` stamps the "Chat closed" marker at the session's last activity so
  // it always sits below (never above) a trailing survey note or rating.
  let prevReal: Date | null = null
  let lastAnyAt: string | null = null

  for (const m of messages) {
    // System messages (survey note + rating) render inline in chronological
    // order but never open a new session/day.
    if (m.sender === 'system') {
      items.push({ kind: 'message', msg: m, key: m.id })
      lastAnyAt = m.createdAt
      continue
    }

    const t = new Date(m.createdAt)
    const valid = !isNaN(t.getTime())

    if (!prevReal) {
      if (valid) items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
    } else if (valid) {
      const gap = t.getTime() - prevReal.getTime()
      const sameDay = isSameLocalDay(prevReal, t)
      if (gap > idleMs) {
        items.push({ kind: 'closed', at: lastAnyAt ?? prevReal.toISOString(), key: `closed-${m.id}` })
        if (!sameDay) items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
        items.push({ kind: 'session', at: m.createdAt, key: `session-${m.id}` })
      } else if (!sameDay) {
        items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
      }
    }

    items.push({ kind: 'message', msg: m, key: m.id })
    lastAnyAt = m.createdAt
    if (valid) prevReal = t
  }

  // Trailing "Chat closed" marker for the current (closed) session — stamped at
  // the last activity so it renders below any survey note / rating chip.
  if (opts?.status === 'closed' && prevReal) {
    items.push({ kind: 'closed', at: lastAnyAt ?? prevReal.toISOString(), key: 'closed-final' })
  }

  return items
}

export const supportChatApi = {
  get: () => apiRequest<SupportChatState>('/support/chat'),
  send: (body: string, attachmentUrl?: string) =>
    apiRequest<SupportMessage>('/support/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ body, ...(attachmentUrl ? { attachmentUrl } : {}) }),
    }),
  deleteMessage: (id: string) =>
    apiRequest<unknown>(`/support/chat/messages/${id}/delete`, { method: 'POST' }),
  markRead: () => apiRequest<unknown>('/support/chat/read', { method: 'POST' }),
  rate: (score: number) =>
    apiRequest<unknown>('/support/chat/rate', {
      method: 'POST',
      body: JSON.stringify({ score }),
    }),
  refundResponse: (requestId: string, network: RefundNetwork, address: string) =>
    apiRequest<SupportMessage>('/support/chat/refund-response', {
      method: 'POST',
      body: JSON.stringify({ requestId, network, address }),
    }),
}
