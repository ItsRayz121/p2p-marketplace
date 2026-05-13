// In dev, Next.js rewrites /api/* → backend, so we use '' (same-origin).
// In production, we call the Railway backend URL directly.
const API_BASE =
  process.env.NODE_ENV === 'development'
    ? ''
    : (process.env.NEXT_PUBLIC_API_URL ?? '')

import { useAuthStore } from '../store/auth.store'
import type { AuthUser } from '../store/auth.store'

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Call this to clear the cached CSRF token (e.g. after a 403 INVALID_CSRF_TOKEN response) */
export function invalidateCsrfToken(): void {
  useAuthStore.getState().setCsrfToken('')
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

async function doRefresh(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Refresh failed')
  const data = (await res.json()) as { accessToken: string }
  return data.accessToken
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const url = `${API_BASE}/api/v1${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }

  // Attach access token from store
  const token = useAuthStore.getState().accessToken
  if (token) headers['Authorization'] = 'Bearer ' + token

  // Attach CSRF token for unsafe methods
  const csrf = useAuthStore.getState().csrfToken
  if (csrf && UNSAFE_METHODS.has(method)) headers['X-CSRF-Token'] = csrf

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: 'include',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }

  // Handle 401 with refresh + retry
  if (res.status === 401) {
    if (!isRefreshing) {
      isRefreshing = true
      try {
        const newToken = await doRefresh()
        useAuthStore.getState().setAccessToken(newToken)
        refreshQueue.forEach((cb) => cb(newToken))
        refreshQueue = []
        isRefreshing = false
        // Retry original request with new token
        headers['Authorization'] = 'Bearer ' + newToken
        const retryController = new AbortController()
        const retryTimeout = setTimeout(() => retryController.abort(), 15_000)
        try {
          const retryRes = await fetch(url, {
            ...options,
            method,
            headers,
            credentials: 'include',
            signal: retryController.signal,
          })
          const retryData = await retryRes.json()
          if (!retryRes.ok) {
            throw new ApiError(
              (retryData as { error?: string }).error ?? 'UNKNOWN_ERROR',
              (retryData as { message?: string }).message ?? 'An error occurred',
              retryRes.status,
              (retryData as { requestId?: string }).requestId,
            )
          }
          return retryData as T
        } finally {
          clearTimeout(retryTimeout)
        }
      } catch {
        isRefreshing = false
        refreshQueue = []
        useAuthStore.getState().clearAuth()
        if (typeof window !== 'undefined') window.location.href = '/login'
        throw new ApiError('UNAUTHORIZED', 'Session expired', 401)
      }
    } else {
      // Queue this request until refresh completes
      return new Promise<T>((resolve, reject) => {
        refreshQueue.push(async (newToken: string) => {
          headers['Authorization'] = 'Bearer ' + newToken
          try {
            const retryController = new AbortController()
            const retryTimeout = setTimeout(() => retryController.abort(), 15_000)
            try {
              const retryRes = await fetch(url, {
                ...options,
                method,
                headers,
                credentials: 'include',
                signal: retryController.signal,
              })
              const retryData = await retryRes.json()
              if (!retryRes.ok) {
                reject(new ApiError(
                  (retryData as { error?: string }).error ?? 'UNKNOWN_ERROR',
                  (retryData as { message?: string }).message ?? 'An error occurred',
                  retryRes.status,
                ))
              } else {
                resolve(retryData as T)
              }
            } finally {
              clearTimeout(retryTimeout)
            }
          } catch (err) {
            reject(err)
          }
        })
      })
    }
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = {}
  }

  if (!res.ok) {
    // Handle 429 Rate Limit
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After')
      throw new ApiError(
        'RATE_LIMITED',
        `Too many requests. ${retryAfter ? `Retry after ${retryAfter}s.` : 'Please wait before retrying.'}`,
        429,
      )
    }

    // Handle 500 with request ID
    if (res.status >= 500) {
      const requestId = res.headers.get('X-Request-Id') ?? undefined
      throw new ApiError(
        (data as { error?: string }).error ?? 'SERVER_ERROR',
        (data as { message?: string }).message ?? 'An internal server error occurred',
        res.status,
        requestId,
      )
    }

    // Stale CSRF token — clear cache and let caller retry once
    if (res.status === 403 && (data as { error?: string }).error === 'INVALID_CSRF_TOKEN') {
      invalidateCsrfToken()
    }

    throw new ApiError(
      (data as { error?: string }).error ?? 'UNKNOWN_ERROR',
      (data as { message?: string }).message ?? 'An error occurred',
      res.status,
      (data as { requestId?: string }).requestId,
    )
  }

  return data as T
}

// Legacy api object for compatibility
export const api = {
  get: <T>(path: string, options?: RequestInit) =>
    apiRequest<T>(path, { method: 'GET', ...options }),

  post: <T>(path: string, body?: unknown, options?: RequestInit) =>
    apiRequest<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),

  patch: <T>(path: string, body?: unknown, options?: RequestInit) =>
    apiRequest<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),

  delete: <T>(path: string, options?: RequestInit) =>
    apiRequest<T>(path, { method: 'DELETE', ...options }),
}

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface Session {
  id: string
  userAgent: string
  ip: string
  createdAt: string
  lastActiveAt: string
  isCurrent: boolean
}

export interface Trade {
  id: string
  adId: string
  buyerId: string
  sellerId: string
  coin: string
  amount: string
  price: string
  totalPkr: string
  status: 'pending' | 'paid' | 'released' | 'disputed' | 'cancelled' | 'expired'
  paymentMethod: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  buyer?: Partial<AuthUser>
  seller?: Partial<AuthUser>
  ad?: Partial<Ad>
}

export interface Ad {
  id: string
  userId: string
  type: 'buy' | 'sell'
  coin: string
  price: string
  minAmount: string
  maxAmount: string
  paymentMethods: string[]
  terms?: string
  status: 'active' | 'inactive' | 'paused'
  createdAt: string
  updatedAt: string
  user?: Partial<AuthUser>
}

export interface KycDocument {
  id: string
  userId: string
  level: 'basic' | 'enhanced'
  status: 'pending' | 'approved' | 'rejected'
  documentType: string
  frontKey?: string
  backKey?: string
  selfieKey?: string
  notes?: string
  reviewedAt?: string
  createdAt: string
}

export interface Notification {
  id: string
  userId: string
  type: string
  title: string
  body: string
  read: boolean
  data?: Record<string, unknown>
  createdAt: string
}

export interface WalletBalance {
  coin: string
  available: string
  locked: string
  total: string
}

export interface Transaction {
  id: string
  userId: string
  type: 'deposit' | 'withdrawal' | 'trade_lock' | 'trade_release' | 'fee' | 'referral_bonus'
  coin: string
  amount: string
  status: 'pending' | 'completed' | 'failed'
  reference?: string
  createdAt: string
}

// ─── API Modules ─────────────────────────────────────────────────────────────

export const authApi = {
  register: (data: { email: string; fullName: string; password: string; referralCode?: string; intendedRole?: 'user' | 'merchant' }) =>
    apiRequest<{ userId: string; email: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  verifyEmail: (data: { email: string; code: string }) =>
    apiRequest<{ verified: boolean }>('/auth/verify-email', { method: 'POST', body: JSON.stringify(data) }),
  resendOtp: (email: string) =>
    apiRequest<{ sent: boolean }>('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email }) }),
  login: (data: { email: string; password: string }) =>
    apiRequest<{ accessToken?: string; preAuthToken?: string; user?: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  refresh: () =>
    apiRequest<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),
  logout: () =>
    apiRequest<void>('/auth/logout', { method: 'POST' }),
  me: () =>
    apiRequest<AuthUser>('/auth/me'),
  getCsrf: () =>
    apiRequest<{ token: string }>('/auth/csrf'),
  forgotPassword: (email: string) =>
    apiRequest<void>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (data: { email: string; code: string; newPassword: string }) =>
    apiRequest<void>('/auth/reset-password', { method: 'POST', body: JSON.stringify(data) }),
  updateProfile: (data: { fullName?: string; username?: string }) =>
    apiRequest<AuthUser>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  checkUsername: (username: string) =>
    apiRequest<{ available: boolean }>('/auth/check-username?username=' + encodeURIComponent(username)),
  verify2fa: (data: { preAuthToken: string; totpCode: string }) =>
    apiRequest<{ accessToken: string; user: AuthUser }>('/auth/2fa/verify', { method: 'POST', body: JSON.stringify(data) }),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiRequest<void>('/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
  getSessions: () =>
    apiRequest<Session[]>('/auth/sessions'),
  revokeSession: (id: string) =>
    apiRequest<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  setup2fa: () =>
    apiRequest<{ secret: string; qrCode: string }>('/auth/2fa/setup', { method: 'POST' }),
  enable2fa: (code: string) =>
    apiRequest<void>('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  disable2fa: (code: string) =>
    apiRequest<void>('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
}

export const marketplaceApi = {
  getRate: (coin: string) =>
    apiRequest<{ rate: number; updatedAt: string; source: string }>(`/marketplace/rate/${coin}`),
  getRates: () =>
    apiRequest<{ rates: Record<string, number>; updatedAt: string }>('/marketplace/rates'),
  getStats: () =>
    apiRequest<{ totalUsers: number; totalTrades: number; totalVolume: string; activeMerchants: number }>('/marketplace/stats'),
  getTopAds: () =>
    apiRequest<{ buys: Ad[]; sells: Ad[] }>('/marketplace/top-ads'),
  getConfig: () =>
    apiRequest<Record<string, unknown>>('/marketplace/config'),
  getAds: (params?: Record<string, string | number | undefined>) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ ads: Ad[]; total: number; page: number; limit: number }>('/marketplace/ads' + qs)
  },
}

export const walletApi = {
  getBalances: () =>
    apiRequest<{ balances: WalletBalance[] }>('/wallet/balances'),
  getBalance: (coin: string) =>
    apiRequest<WalletBalance>(`/wallet/balances/${coin}`),
  getTransactions: (params?: { page?: number; limit?: number; coin?: string; type?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ transactions: Transaction[]; total: number }>('/wallet/transactions' + qs)
  },
  getDepositAddress: (coin: string) =>
    apiRequest<{ address: string; network: string; memo?: string }>(`/wallet/deposit/${coin}`),
  requestWithdrawal: (data: { coin: string; amount: string; address: string; network: string }) =>
    apiRequest<{ id: string; status: string }>('/wallet/withdraw', { method: 'POST', body: JSON.stringify(data) }),
}

export const tradesApi = {
  createTrade: (data: { adId: string; amount: string; paymentMethod: string }) =>
    apiRequest<Trade>('/trades', { method: 'POST', body: JSON.stringify(data) }),
  getTrade: (id: string) =>
    apiRequest<Trade>(`/trades/${id}`),
  getMyTrades: (params?: { page?: number; limit?: number; status?: string; role?: 'buyer' | 'seller' }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ trades: Trade[]; total: number }>('/trades/me' + qs)
  },
  markPaid: (id: string, data?: { paymentReference?: string; paymentProofKey?: string }) =>
    apiRequest<Trade>(`/trades/${id}/mark-paid`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  releaseCrypto: (id: string) =>
    apiRequest<Trade>(`/trades/${id}/release`, { method: 'POST' }),
  cancelTrade: (id: string, reason?: string) =>
    apiRequest<Trade>(`/trades/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  openDispute: (id: string, data: { reason: string; evidenceKey?: string }) =>
    apiRequest<Trade>(`/trades/${id}/dispute`, { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (id: string, message: string) =>
    apiRequest<{ id: string; message: string; createdAt: string }>(`/trades/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) }),
  getMessages: (id: string) =>
    apiRequest<{ messages: Array<{ id: string; senderId: string; message: string; createdAt: string }> }>(`/trades/${id}/messages`),
}

export const adsApi = {
  createAd: (data: Partial<Ad>) =>
    apiRequest<Ad>('/ads', { method: 'POST', body: JSON.stringify(data) }),
  updateAd: (id: string, data: Partial<Ad>) =>
    apiRequest<Ad>(`/ads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAd: (id: string) =>
    apiRequest<void>(`/ads/${id}`, { method: 'DELETE' }),
  getAd: (id: string) =>
    apiRequest<Ad>(`/ads/${id}`),
  getMyAds: (params?: { page?: number; limit?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ ads: Ad[]; total: number }>('/ads/me' + qs)
  },
  pauseAd: (id: string) =>
    apiRequest<Ad>(`/ads/${id}/pause`, { method: 'POST' }),
  activateAd: (id: string) =>
    apiRequest<Ad>(`/ads/${id}/activate`, { method: 'POST' }),
}

export const kycApi = {
  getStatus: () =>
    apiRequest<{ status: string; level: string; documents: KycDocument[] }>('/kyc/status'),
  submitBasic: (data: { documentType: string; frontKey: string; backKey?: string }) =>
    apiRequest<KycDocument>('/kyc/basic', { method: 'POST', body: JSON.stringify(data) }),
  submitEnhanced: (data: { selfieKey: string; additionalDocKey?: string }) =>
    apiRequest<KycDocument>('/kyc/enhanced', { method: 'POST', body: JSON.stringify(data) }),
  // Admin/reviewer endpoints
  getPendingReviews: (params?: { page?: number; limit?: number }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ documents: KycDocument[]; total: number }>('/kyc/pending' + qs)
  },
  reviewDocument: (id: string, data: { status: 'approved' | 'rejected'; notes?: string }) =>
    apiRequest<KycDocument>(`/kyc/${id}/review`, { method: 'POST', body: JSON.stringify(data) }),
}

export const notificationsApi = {
  getAll: (params?: { page?: number; limit?: number; unreadOnly?: boolean }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ notifications: Notification[]; total: number; unreadCount: number }>('/notifications' + qs)
  },
  markRead: (id: string) =>
    apiRequest<void>(`/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () =>
    apiRequest<void>('/notifications/read-all', { method: 'POST' }),
  getUnreadCount: () =>
    apiRequest<{ count: number }>('/notifications/unread-count'),
}

export const dashboardApi = {
  getSummary: () =>
    apiRequest<{
      totalTrades: number
      activeTrades: number
      completedTrades: number
      totalVolumeUsd: string
      balance: WalletBalance[]
    }>('/dashboard/summary'),
  getRecentActivity: () =>
    apiRequest<{ activities: Array<{ type: string; description: string; createdAt: string }> }>('/dashboard/activity'),
}

export const merchantsApi = {
  apply: (data: { businessName?: string; description?: string; proofKey?: string }) =>
    apiRequest<{ applicationId: string; status: string }>('/merchants/apply', { method: 'POST', body: JSON.stringify(data) }),
  getProfile: () =>
    apiRequest<{ id: string; userId: string; status: string; businessName?: string; rating: number; totalTrades: number }>('/merchants/me'),
  getPublicProfile: (id: string) =>
    apiRequest<{ id: string; username: string; rating: number; totalTrades: number; responseTime: string }>(`/merchants/${id}`),
  getPendingApplications: () =>
    apiRequest<{ applications: Array<{ id: string; userId: string; status: string; createdAt: string }> }>('/merchants/pending'),
  reviewApplication: (id: string, data: { status: 'approved' | 'rejected'; notes?: string }) =>
    apiRequest<void>(`/merchants/${id}/review`, { method: 'POST', body: JSON.stringify(data) }),
}

export const instantBuyApi = {
  getQuote: (data: { coin: string; amountPkr: number }) =>
    apiRequest<{ coin: string; amountPkr: number; amountCrypto: string; rate: number; fee: string; expiresAt: string }>('/instant-buy/quote', { method: 'POST', body: JSON.stringify(data) }),
  executeOrder: (data: { quoteId: string; paymentMethod: string }) =>
    apiRequest<{ orderId: string; status: string; paymentInstructions: Record<string, string> }>('/instant-buy/order', { method: 'POST', body: JSON.stringify(data) }),
  getOrder: (id: string) =>
    apiRequest<{ id: string; status: string; coin: string; amount: string; amountPkr: string; createdAt: string }>(`/instant-buy/orders/${id}`),
}

export const referralApi = {
  getStats: () =>
    apiRequest<{ referralCode: string; totalReferrals: number; totalEarned: string; pendingEarnings: string }>('/referral/stats'),
  getReferrals: (params?: { page?: number; limit?: number }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ referrals: Array<{ id: string; email: string; joinedAt: string; status: string }> }>('/referral/list' + qs)
  },
}

export const leaderboardApi = {
  getTop: (params?: { period?: 'daily' | 'weekly' | 'monthly' | 'all-time'; limit?: number }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ entries: Array<{ rank: number; userId: string; username: string; volume: string; trades: number }> }>('/leaderboard' + qs)
  },
  getMyRank: () =>
    apiRequest<{ rank: number; volume: string; trades: number }>('/leaderboard/me'),
}

export const usersApi = {
  getProfile: (username: string) =>
    apiRequest<Partial<AuthUser>>(`/users/${username}`),
  search: (query: string) =>
    apiRequest<{ users: Array<Partial<AuthUser>> }>(`/users/search?q=${encodeURIComponent(query)}`),
}

export const gasFeeApi = {
  estimate: (data: { coin: string; network: string }) =>
    apiRequest<{ fee: string; feePkr: string; estimatedTime: string }>('/gas-fee/estimate', { method: 'POST', body: JSON.stringify(data) }),
}

function buildQs(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const entries = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  return entries.length ? '?' + new URLSearchParams(entries).toString() : ''
}

export const adminApi = {
  // Dashboard
  getStats: () =>
    apiRequest<{ totalUsers: number; totalTrades: number; totalVolume: string; pendingKyc: number; openDisputes: number; pendingWithdrawals?: number; pendingInstantBuy?: number; todayRevenuePkr?: string }>('/admin/stats'),

  // Users
  getUsers: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ users: AuthUser[]; total: number }>('/admin/users' + buildQs(params)),
  getUser: (id: string) =>
    apiRequest<AuthUser>(`/admin/users/${id}`),
  updateUser: (id: string, data: Partial<AuthUser>) =>
    apiRequest<AuthUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  banUser: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/users/${id}/ban`, { method: 'POST', body: JSON.stringify(data) }),
  unbanUser: (id: string) =>
    apiRequest<void>(`/admin/users/${id}/unban`, { method: 'POST' }),
  suspendUser: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/users/${id}/suspend`, { method: 'POST', body: JSON.stringify(data) }),
  seizeCollateral: (id: string) =>
    apiRequest<void>(`/admin/users/${id}/seize-collateral`, { method: 'POST' }),

  // KYC
  getKycQueue: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ submissions: unknown[]; total: number }>('/admin/kyc/queue' + buildQs(params)),
  getKycSubmission: (id: string) =>
    apiRequest<unknown>(`/admin/kyc/${id}`),
  approveKyc: (id: string, data: { notes?: string }) =>
    apiRequest<void>(`/admin/kyc/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
  rejectKyc: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/kyc/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

  // Merchant KYC
  getMerchantKycQueue: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ submissions: unknown[]; total: number }>('/admin/merchant-kyc/queue' + buildQs(params)),
  approveMerchantKyc: (id: string) =>
    apiRequest<void>(`/admin/merchant-kyc/${id}/approve`, { method: 'POST' }),
  rejectMerchantKyc: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/merchant-kyc/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

  // Trades
  getTrades: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: Trade[]; total: number }>('/admin/trades' + buildQs(params)),
  adminConfirmPayment: (id: string) =>
    apiRequest<Trade>(`/admin/trades/${id}/confirm-payment`, { method: 'POST' }),
  adminCancelTrade: (id: string) =>
    apiRequest<Trade>(`/admin/trades/${id}/cancel`, { method: 'POST' }),

  // Disputes
  getDisputes: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ disputes: Trade[]; total: number }>('/admin/disputes' + buildQs(params)),
  getDispute: (id: string) =>
    apiRequest<Trade>(`/admin/disputes/${id}`),
  resolveDispute: (tradeId: string, data: { winner: 'buyer' | 'seller'; resolution: string; resolutionNote?: string }) =>
    apiRequest<Trade>(`/admin/disputes/${tradeId}/resolve`, { method: 'POST', body: JSON.stringify(data) }),

  // Instant Buy
  getInstantBuyOrders: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ orders: unknown[]; total: number }>('/admin/instant-buy' + buildQs(params)),
  getInstantBuyOrder: (id: string) =>
    apiRequest<unknown>(`/admin/instant-buy/${id}`),
  approveInstantBuy: (id: string, data: { txHash: string }) =>
    apiRequest<void>(`/admin/instant-buy/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
  rejectInstantBuy: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/instant-buy/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

  // Withdrawals
  getWithdrawals: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ withdrawals: unknown[]; total: number }>('/admin/withdrawals' + buildQs(params)),
  approveWithdrawal: (id: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/approve`, { method: 'POST' }),
  rejectWithdrawal: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

  // Config
  getConfig: () =>
    apiRequest<Record<string, unknown>>('/admin/config'),
  updateConfig: (data: { key: string; value: string }) =>
    apiRequest<void>('/admin/config', { method: 'PATCH', body: JSON.stringify(data) }),

  // Analytics
  getAnalytics: (params?: Record<string, string | number | undefined>) =>
    apiRequest<unknown>('/admin/analytics' + buildQs(params)),

  // Wallet
  getWalletAddresses: () =>
    apiRequest<{ addresses: Array<{ coin: string; network: string; address: string; updatedAt?: string }> }>('/admin/wallet/addresses'),
  updateWalletAddress: (data: { coin: string; network: string; address: string }) =>
    apiRequest<void>('/admin/wallet/addresses', { method: 'PUT', body: JSON.stringify(data) }),

  // Gas Orders
  getGasOrders: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ orders: unknown[]; total: number }>('/admin/gas-orders' + buildQs(params)),
  retryGasOrder: (id: string) =>
    apiRequest<void>(`/admin/gas-orders/${id}/retry`, { method: 'POST' }),
  refundGasOrder: (id: string) =>
    apiRequest<void>(`/admin/gas-orders/${id}/refund`, { method: 'POST' }),

  // Audit Log
  getAuditLog: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ entries: Array<{ id: string; userId: string; action: string; details: unknown; ip?: string; userAgent?: string; createdAt: string }>; total: number }>('/admin/audit-log' + buildQs(params)),
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export type HealthCheckResponse = {
  status: 'ok' | 'degraded'
  timestamp?: string
  uptimeSeconds?: number
  responseMs?: number
  version?: string
  services?: {
    db: { status: 'ok' | 'error'; latencyMs: number }
    redis: { status: 'ok' | 'error'; latencyMs: number }
  }
}

export async function checkApiHealth(): Promise<HealthCheckResponse | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5_000)
    try {
      const res = await fetch(`${API_BASE}/health`, {
        credentials: 'include',
        signal: controller.signal,
      })
      return await res.json() as HealthCheckResponse
    } finally {
      clearTimeout(timeoutId)
    }
  } catch {
    return null
  }
}
