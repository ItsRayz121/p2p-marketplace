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
  postMessage: (threadId: string, body: string) =>
    apiRequest<ThreadMessage>(`/messages/${threadId}`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
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
