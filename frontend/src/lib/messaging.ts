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
}

export interface TradeEpisode {
  id: string
  market: 'usdt' | 'ctm'
  tradeId: string
  tradeRef: string
  outcome: 'active' | 'completed' | 'cancelled' | 'expired' | 'disputed'
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
}

export const messagingApi = {
  getSummary: () => apiRequest<InboxSummary>('/messages/summary'),
  getInbox: () => apiRequest<InboxItem[]>('/messages'),
  getThread: (threadId: string) => apiRequest<ThreadView>(`/messages/${threadId}`),
  postMessage: (threadId: string, body: string, attachmentUrl?: string) =>
    apiRequest<ThreadMessage>(`/messages/${threadId}`, {
      method: 'POST',
      body: JSON.stringify({ body, ...(attachmentUrl ? { attachmentUrl } : {}) }),
    }),
  deleteMessage: (threadId: string, messageId: string) =>
    apiRequest<unknown>(`/messages/${threadId}/${messageId}/delete`, { method: 'POST' }),
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
}
