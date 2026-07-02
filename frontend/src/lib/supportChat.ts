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
  rating?: number | null
  createdAt: string
}

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
  let prev: Date | null = null

  // System messages (satisfaction ratings) render inline but never start a new
  // session/day — and a rating happens AFTER a session closes, so it must render
  // below its "Chat closed" marker. We buffer them and flush after the marker.
  let pendingSystem: M[] = []
  const flushSystem = () => {
    for (const s of pendingSystem) items.push({ kind: 'message', msg: s, key: s.id })
    pendingSystem = []
  }

  for (const m of messages) {
    if (m.sender === 'system') {
      pendingSystem.push(m)
      continue
    }

    const t = new Date(m.createdAt)
    const valid = !isNaN(t.getTime())

    if (!prev) {
      if (valid) items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
      flushSystem()
    } else if (valid) {
      const gap = t.getTime() - prev.getTime()
      const sameDay = isSameLocalDay(prev, t)
      if (gap > idleMs) {
        items.push({ kind: 'closed', at: prev.toISOString(), key: `closed-${m.id}` })
        flushSystem() // the just-closed session's rating renders after its marker
        if (!sameDay) items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
        items.push({ kind: 'session', at: m.createdAt, key: `session-${m.id}` })
      } else {
        flushSystem()
        if (!sameDay) items.push({ kind: 'day', at: m.createdAt, key: `day-${m.id}` })
      }
    } else {
      flushSystem()
    }

    items.push({ kind: 'message', msg: m, key: m.id })
    if (valid) prev = t
  }

  // Close the final session (if closed) BEFORE flushing its trailing rating.
  if (opts?.status === 'closed' && prev) {
    items.push({ kind: 'closed', at: prev.toISOString(), key: 'closed-final' })
  }
  flushSystem()

  return items
}

export const supportChatApi = {
  get: () => apiRequest<SupportChatState>('/support/chat'),
  send: (body: string) =>
    apiRequest<SupportMessage>('/support/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  markRead: () => apiRequest<unknown>('/support/chat/read', { method: 'POST' }),
  rate: (score: number) =>
    apiRequest<unknown>('/support/chat/rate', {
      method: 'POST',
      body: JSON.stringify({ score }),
    }),
}
