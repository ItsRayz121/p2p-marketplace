// Client for the persistent counterparty messaging inbox (Phase 4).
// Gated by messaging_inbox_enabled on the backend; getSummary().enabled tells the
// UI whether to reveal the feature.

import { apiRequest } from '@/lib/api'

export interface ChatUser {
  id: string
  username: string | null
  fullName: string | null
  avatarUrl: string | null
}

export interface InboxItem {
  threadId: string
  other: ChatUser
  lastMessageAt: string
  lastMessagePreview: string | null
  /** Delivery/read status of the last message, only when the viewer sent it. */
  lastMessageStatus: 'sent' | 'delivered' | 'read' | null
  unread: boolean
  activeTrades: number
  totalTrades: number
}

export interface InboxSummary {
  enabled: boolean
  unreadThreads: number
  activeTrades: number
}

export interface ThreadMessage {
  id: string
  senderId: string
  body: string
  attachmentUrl: string | null
  /** Set when the author retracted the message — render a tombstone. */
  deletedAt?: string | null
  isSystem: boolean
  createdAt: string
  /** Delivery/read tick state — only set for messages the viewer themselves sent. */
  status?: 'sent' | 'delivered' | 'read' | null
  /** Echoes the sender's clientId (see messagingApi.postMessage) — lets a pending
   *  bubble reconcile against this message arriving via a concurrent poll before
   *  the original send's own response comes back. Null for folded trade-room lines. */
  clientId?: string | null
}

export interface TradeEpisode {
  id: string
  market: 'usdt' | 'ctm'
  tradeId: string
  tradeRef: string
  outcome: 'active' | 'completed' | 'cancelled' | 'expired' | 'disputed' | 'dispute_resolved'
  fiatAmount: string | null
  startedAt: string
  endedAt: string | null
  /** Live trade status — present only for ACTIVE episodes (drives the thread progress bar). */
  status?: string | null
  /** Whether the viewer already rated this (completed) trade — hides the rate prompt. */
  ratedByMe?: boolean
}

/**
 * Ordered in-progress step ladders per market (terminal states excluded). Used to
 * render a compact progress bar for an active trade inside the chat thread.
 */
const USDT_STEPS = ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released']
const CTM_STEPS = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming', 'completed']
const STEP_LABELS: Record<string, string> = {
  payment_pending: 'Awaiting payment', awaiting_payment: 'Awaiting payment',
  payment_uploaded: 'Payment sent', payment_confirmed: 'Payment confirmed',
  crypto_sent: 'Crypto sent', crypto_released: 'Completed',
  seller_transferring: 'Seller sending tokens', proof_submitted: 'Tokens sent',
  buyer_confirming: 'Confirming receipt', completed: 'Completed',
}

/** Progress of an active episode → { index, total, label } (or null if unknown). */
export function episodeProgress(ep: TradeEpisode): { index: number; total: number; label: string } | null {
  if (ep.outcome !== 'active' || !ep.status) return null
  const ladder = ep.market === 'ctm' ? CTM_STEPS : USDT_STEPS
  const i = ladder.indexOf(ep.status)
  if (i < 0) return null
  return { index: i + 1, total: ladder.length, label: STEP_LABELS[ep.status] ?? ep.status }
}

export interface ThreadStats {
  completed: number
  cancelled: number
  expired: number
  disputed: number
  active: number
  total: number
}

export interface ThreadView {
  threadId: string
  other: ChatUser
  stats: ThreadStats
  episodes: TradeEpisode[]
  messages: ThreadMessage[]
  /** True if the viewer has blocked the other participant. */
  blockedByMe: boolean
  /** True if the other participant has blocked the viewer. */
  blockedMe: boolean
}

export const messagingApi = {
  getSummary: () => apiRequest<InboxSummary>('/messages/summary'),
  getInbox: () => apiRequest<InboxItem[]>('/messages'),
  /** `markRead: false` skips marking the counterparty's messages read — used for
   *  a background poll while the tab isn't actually visible to the user. */
  getThread: (threadId: string, opts?: { markRead?: boolean }) =>
    apiRequest<ThreadView>(`/messages/${threadId}${opts?.markRead === false ? '?markRead=0' : ''}`),
  /** `clientId` makes a retried send idempotent — reuse the same id across retries
   *  of the same message so a lost-response retry can't create a duplicate. */
  postMessage: (threadId: string, body: string, attachmentUrl?: string, clientId?: string) =>
    apiRequest<ThreadMessage>(`/messages/${threadId}`, {
      method: 'POST',
      body: JSON.stringify({ body, ...(attachmentUrl ? { attachmentUrl } : {}), ...(clientId ? { clientId } : {}) }),
    }),
  deleteMessage: (threadId: string, messageId: string) =>
    apiRequest<unknown>(`/messages/${threadId}/${messageId}/delete`, { method: 'POST' }),
  /** Find people by username to start a new conversation (no shared trade needed). */
  search: (q: string) => apiRequest<ChatUser[]>(`/messages/search?q=${encodeURIComponent(q)}`),
  /** Get-or-create a thread with a user by username; returns its threadId. */
  start: (username: string) =>
    apiRequest<{ threadId: string }>('/messages/start', { method: 'POST', body: JSON.stringify({ username }) }),
  block: (threadId: string) => apiRequest<{ blocked: boolean }>(`/messages/${threadId}/block`, { method: 'POST' }),
  unblock: (threadId: string) => apiRequest<{ blocked: boolean }>(`/messages/${threadId}/unblock`, { method: 'POST' }),
  report: (threadId: string, reason: string) =>
    apiRequest<{ filed: boolean }>(`/messages/${threadId}/report`, { method: 'POST', body: JSON.stringify({ reason }) }),
}

/** Deep link to a trade room from an episode. */
export function episodeTradeHref(ep: TradeEpisode): string {
  return ep.market === 'ctm' ? `/ctm/trade/${ep.tradeRef}` : `/trade/${ep.tradeId}`
}

export const OUTCOME_LABEL: Record<TradeEpisode['outcome'], string> = {
  active: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  disputed: 'Disputed',
  dispute_resolved: 'Resolved',
}
