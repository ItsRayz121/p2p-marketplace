import { apiRequest } from './api'

// ─── Maker gate (stage 2) ────────────────────────────────────────────────────

export interface MakerRequirement {
  key: 'kyc' | 'username' | 'telegram' | 'whatsapp' | 'approval'
  label: string
  met: boolean
}

export interface MakerStatusView {
  gateEnabled: boolean
  /** True when the user may post right now (gate off, trusted, or all requirements met). */
  eligible: boolean
  trusted: boolean
  makerStatus: 'none' | 'pending' | 'approved' | 'rejected'
  reviewNote: string | null
  whatsappNumber: string | null
  requirements: MakerRequirement[]
  canApply: boolean
  reviewFirstN: number
}

export const makerApi = {
  getStatus: () => apiRequest<MakerStatusView>('/maker/status'),
  saveWhatsapp: (whatsappNumber: string) =>
    apiRequest<MakerStatusView>('/maker/whatsapp', { method: 'POST', body: JSON.stringify({ whatsappNumber }) }),
  apply: () => apiRequest<MakerStatusView>('/maker/apply', { method: 'POST' }),
}

export interface MakerApplication {
  id: string
  username: string | null
  fullName: string | null
  email: string
  kycLevel: string
  kycStatus: string
  createdAt: string
  telegramUsername: string | null
  whatsappNumber: string | null
  makerAppliedAt: string | null
  makerApprovedAt: string | null
  makerReviewNote: string | null
  isTrusted: boolean
  tradingHold: boolean
  tradeStats: { totalTrades: number; completedTrades: number; completionRate: string } | null
}

export interface PendingAdItem {
  kind: 'usdt' | 'ctm'
  id: string
  side: string
  title: string
  price: string
  minOrder: string
  maxOrder: string
  totalAmount: string
  paymentMethods: string[]
  terms: string | null
  tradeWindowMins: number | null
  createdAt: string
  maker: { id: string; username: string | null; kycLevel: string; tradeStats: { totalTrades: number; completedTrades: number } | null }
}

export const adminMakerApi = {
  getApplications: (status: 'pending' | 'approved' | 'rejected' = 'pending') =>
    apiRequest<{ gateEnabled: boolean; applications: MakerApplication[] }>(`/admin/makers?status=${status}`),
  decideMaker: (id: string, data: { approve: boolean; note?: string }) =>
    apiRequest<void>(`/admin/makers/${id}/decision`, { method: 'POST', body: JSON.stringify(data) }),
  getAdReview: () => apiRequest<{ ads: PendingAdItem[]; listings: PendingAdItem[] }>('/admin/ad-review'),
  decideAd: (kind: 'usdt' | 'ctm', id: string, data: { approve: boolean; note?: string }) =>
    apiRequest<void>(`/admin/ad-review/${kind}/${id}/decision`, { method: 'POST', body: JSON.stringify(data) }),
}
