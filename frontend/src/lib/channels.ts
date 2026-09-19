// Client for the Telegram-style broadcast Channels tab inside Messaging.
// Broadcast-only: the owner posts, every other member reads. See
// backend/src/services/channel.service.ts for the full model.

import { apiRequest } from '@/lib/api'
import type { SharedAdPreview, SharedGasPreview } from '@/lib/messaging'

export interface ChannelOwner {
  id: string
  username: string | null
  fullName: string | null
  avatarUrl: string | null
}

export interface ChannelCard {
  id: string
  name: string
  description: string | null
  slug: string
  visibility: 'public' | 'private'
  avatarUrl: string | null
  memberCount: number
  ownerId: string
  lastMessageAt: string
  createdAt: string
  autoShareListings: boolean
  owner: ChannelOwner
}

export interface MyChannel extends ChannelCard {
  myRole: 'owner' | 'subscriber'
}

export interface DirectoryChannel extends ChannelCard {
  isMember: boolean
}

export interface ChannelDetail extends ChannelCard {
  myRole: 'owner' | 'subscriber' | null
  isMember: boolean
}

export interface ChannelMessage {
  id: string
  senderId: string
  body: string
  attachmentUrl?: string | null
  deletedAt?: string | null
  editedAt?: string | null
  isSystem: boolean
  createdAt: string
  clientId?: string | null
  sharedAd?: SharedAdPreview | null
  sharedGas?: SharedGasPreview | null
}

export interface ChannelMember {
  role: 'owner' | 'subscriber'
  joinedAt: string
  user: ChannelOwner
}

export const channelsApi = {
  listMine: () => apiRequest<MyChannel[]>('/channels'),
  directory: (q: string) => apiRequest<DirectoryChannel[]>(`/channels/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  create: (input: { name: string; description?: string; visibility: 'public' | 'private' }) =>
    apiRequest<{ id: string; slug: string }>('/channels', { method: 'POST', body: JSON.stringify(input) }),
  get: (idOrSlug: string) => apiRequest<ChannelDetail>(`/channels/${idOrSlug}`),
  messages: (channelId: string) => apiRequest<ChannelMessage[]>(`/channels/${channelId}/messages`),
  post: (channelId: string, body: string, clientId?: string, sharedAd?: { market: 'usdt' | 'ctm'; id: string }, attachmentUrl?: string, sharedGasChainSlug?: string) =>
    apiRequest<ChannelMessage>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        ...(clientId ? { clientId } : {}),
        ...(sharedAd ? { sharedAdMarket: sharedAd.market, sharedAdId: sharedAd.id } : {}),
        ...(attachmentUrl ? { attachmentUrl } : {}),
        ...(sharedGasChainSlug ? { sharedGasChainSlug } : {}),
      }),
    }),
  deleteMessage: (channelId: string, messageId: string) =>
    apiRequest<unknown>(`/channels/${channelId}/messages/${messageId}/delete`, { method: 'POST' }),
  editMessage: (channelId: string, messageId: string, body: string) =>
    apiRequest<ChannelMessage>(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  join: (channelId: string) => apiRequest<{ joined: boolean }>(`/channels/${channelId}/join`, { method: 'POST' }),
  leave: (channelId: string) => apiRequest<{ left: boolean }>(`/channels/${channelId}/leave`, { method: 'POST' }),
  update: (channelId: string, input: { name?: string; description?: string; visibility?: 'public' | 'private'; avatarUrl?: string; autoShareListings?: boolean }) =>
    apiRequest<ChannelCard>(`/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(input) }),
  regenerateInvite: (channelId: string) => apiRequest<{ slug: string }>(`/channels/${channelId}/regenerate-invite`, { method: 'POST' }),
  delete: (channelId: string) => apiRequest<{ deleted: boolean }>(`/channels/${channelId}`, { method: 'DELETE' }),
  listMembers: (channelId: string) => apiRequest<ChannelMember[]>(`/channels/${channelId}/members`),
  kick: (channelId: string, userId: string) => apiRequest<{ kicked: boolean }>(`/channels/${channelId}/members/${userId}/kick`, { method: 'POST' }),
}
