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
  sender: 'user' | 'admin'
  body: string
  createdAt: string
}

export interface SupportChatState {
  conversation: { id: string; status: string; unreadByUser: boolean; lastMessageAt: string } | null
  messages: SupportMessage[]
}

export const supportChatApi = {
  get: () => apiRequest<SupportChatState>('/support/chat'),
  send: (body: string) =>
    apiRequest<SupportMessage>('/support/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  markRead: () => apiRequest<unknown>('/support/chat/read', { method: 'POST' }),
}
