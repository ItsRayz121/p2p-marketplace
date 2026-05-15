// In dev, Next.js rewrites /api/* → backend, so we use '' (same-origin).
// In production, we call the Railway backend URL directly.
function resolveApiBase(): string {
  if (process.env.NODE_ENV === 'development') return ''
  const v = process.env.NEXT_PUBLIC_API_URL
  if (!v) {
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.error(
        '[PakSwap] NEXT_PUBLIC_API_URL is not set — API calls will hit the current origin and 404. Set it in Vercel → Settings → Environment Variables to your Railway backend URL (no trailing slash, no /api).',
      )
    }
    return ''
  }
  return v.replace(/\/$/, '')
}
const API_BASE = resolveApiBase()

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

// These endpoints handle their own auth — a 401 from them is a real failure,
// not a token-expiry. Never attempt a refresh cycle for them.
const NO_REFRESH_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/verify-email',
  '/auth/resend-otp',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/refresh',
  '/auth/2fa/verify',
])

// Backend wraps every successful response in { success: true, data: <T> }.
// Unwrap so callers get the inner data directly.
function unwrapEnvelope<T>(raw: unknown): T {
  if (
    raw &&
    typeof raw === 'object' &&
    'success' in (raw as Record<string, unknown>) &&
    'data' in (raw as Record<string, unknown>)
  ) {
    return (raw as { data: T }).data
  }
  return raw as T
}

async function doRefresh(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Refresh failed')
  const raw = await res.json()
  const data = unwrapEnvelope<{ accessToken: string }>(raw)
  return data.accessToken
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const url = `${API_BASE}/api/v1${path}`

  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  }
  // Only set Content-Type when there is a body — Fastify rejects empty bodies with this header
  if (options?.body !== undefined && options.body !== null) {
    headers['Content-Type'] = 'application/json'
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
    // Public auth endpoints return 401 for legitimate failures (wrong password, etc.).
    // Do not attempt a refresh for them — just surface the backend error directly.
    if (NO_REFRESH_PATHS.has(path)) {
      let body: unknown = {}
      try { body = await res.json() } catch { /* empty */ }
      throw new ApiError(
        (body as { error?: string }).error ?? 'UNAUTHORIZED',
        (body as { message?: string }).message ?? 'Invalid credentials',
        401,
        (body as { requestId?: string }).requestId,
      )
    }

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
          return unwrapEnvelope<T>(retryData)
        } finally {
          clearTimeout(retryTimeout)
        }
      } catch {
        isRefreshing = false
        refreshQueue = []
        const wasAuthenticated = !!useAuthStore.getState().user
        useAuthStore.getState().clearAuth()
        // Only redirect to login if the user had an active session — avoids
        // spurious redirects when visiting public pages without a session.
        if (typeof window !== 'undefined' && wasAuthenticated) {
          window.location.href = '/login'
        }
        throw new ApiError(
          'UNAUTHORIZED',
          wasAuthenticated ? 'Session expired. Please log in again.' : 'Please log in to continue.',
          401,
        )
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
                resolve(unwrapEnvelope<T>(retryData))
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

    // Stale CSRF token — clear cache and silently fetch a fresh one for the next request
    if (res.status === 403 && (data as { error?: string }).error === 'INVALID_CSRF_TOKEN') {
      invalidateCsrfToken()
      apiRequest<{ token: string }>('/auth/csrf')
        .then((d) => useAuthStore.getState().setCsrfToken(d.token))
        .catch(() => {})
    }

    throw new ApiError(
      (data as { error?: string }).error ?? 'UNKNOWN_ERROR',
      (data as { message?: string }).message ?? 'An error occurred',
      res.status,
      (data as { requestId?: string }).requestId,
    )
  }

  return unwrapEnvelope<T>(data)
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
  orderRef?: string
  adId: string
  buyerId: string
  sellerId: string
  coin: string
  amount: string
  price: string
  totalPkr: string
  status: 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed' | 'expired'
  paymentMethod: string
  paymentProofUrl?: string
  txHash?: string
  buyerRated?: boolean
  sellerRated?: boolean
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

// Shape returned by GET /marketplace/ads
export interface MarketplaceAd {
  id: string
  side: string
  coin: string
  network: string
  priceType: string
  price: string
  floatOffset: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  tradeWindow: number
  terms: string
  status: string
  createdAt: string
  seller: {
    id: string
    username: string
    badge: string
    tradeStats: { completionRate: string; totalTrades: number; avgRating: string } | null
    hasCollateral: boolean
  }
}

export interface KycDocument {
  id: string
  userId: string
  tier: 'basic' | 'enhanced'
  status: 'pending' | 'approved' | 'rejected' | 'needs_revision'
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  rejectionReason?: string | null
  notes?: string | null
  createdAt: string
  reviewedAt?: string | null
}

export interface Notification {
  id: string
  userId: string
  type: string
  title: string
  body: string
  isRead: boolean
  metadata?: Record<string, unknown>
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
  network: string
  amount: string
  fee?: string
  status: 'pending' | 'completed' | 'failed'
  reference?: string
  createdAt: string
}

export type WithdrawalStatus =
  | 'email_pending'
  | 'pending'
  | 'first_approved'
  | 'approved'
  | 'auto_approved'
  | 'on_hold'
  | 'sent'
  | 'completed'
  | 'rejected'
  | 'cancelled'

export interface TrustedAddress {
  id: string
  userId: string
  coin: string
  network: string
  address: string
  label: string
  activatesAt: string
  addedAt: string
  lastUsedAt: string | null
  removedAt: string | null
}

// ─── API Modules ─────────────────────────────────────────────────────────────

export const authApi = {
  register: (data: { email: string; fullName: string; password: string; referralCode?: string; intendedRole?: 'user' | 'merchant' }) =>
    apiRequest<{ userId: string; email: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  verifyEmail: (data: { email: string; code: string }) =>
    apiRequest<{ message: string; accessToken: string; user: AuthUser }>('/auth/verify-email', { method: 'POST', body: JSON.stringify(data) }),
  resendOtp: (email: string, type: 'verify' | 'reset' = 'verify') =>
    apiRequest<{ sent: boolean }>('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email, type }) }),
  login: (data: { email: string; password: string }) =>
    apiRequest<{ accessToken?: string; preAuthToken?: string; user?: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  refresh: () =>
    apiRequest<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),
  logout: () =>
    apiRequest<void>('/auth/logout', { method: 'POST' }),
  me: async (): Promise<AuthUser> => {
    const res = await apiRequest<{ user: AuthUser }>('/auth/me')
    return res.user
  },
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
  verify2fa: (data: { preAuthToken: string; code: string }) =>
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
    apiRequest<{ rates: Record<string, number>; updatedAt: string; source: string }>('/marketplace/rates'),
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
    return apiRequest<{ ads: MarketplaceAd[]; total: number; page: number; limit: number }>('/marketplace/ads' + qs)
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
  getDepositAddress: (coin: string, network?: string) =>
    network
      ? apiRequest<{ address: string; coin: string; network: string; chainId?: number; chainName?: string; minConfirmations?: number; family?: string; memo?: string }>(
          `/wallet/address/${coin}/${network}`,
        )
      : apiRequest<{ address: string; coin: string; network: string; chainId?: number; chainName?: string; minConfirmations?: number; family?: string; memo?: string }>(
          `/wallet/deposit/${coin}`,
        ),
  getChains: () =>
    apiRequest<{ chains: Array<{ id: string; chainId: number; name: string; family: string; nativeSymbol: string; networkLabel: string; minConfirmations: number; tokens: Array<{ symbol: string; decimals: number }> }> }>(
      '/wallet/chains',
    ),
  getRecentDeposits: () =>
    apiRequest<{ deposits: Array<{
      id: string
      chain: string
      chainName: string
      symbol: string
      amount: string
      confirmations: number
      minConfirmations: number
      progress: number | null
      status: 'detected' | 'credited' | 'rejected'
      rejectionReason: string | null
      txHash: string
      explorerUrl?: string
      detectedAt: string
      creditedAt: string | null
    }> }>('/wallet/deposits'),
  requestWithdrawal: (data: { coin: string; amount: string; address: string; network: string }) =>
    apiRequest<{ id: string; status: WithdrawalStatus; orderRef: string }>('/wallet/withdraw', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': cryptoRandomId() },
      body: JSON.stringify({
        coin: data.coin,
        network: data.network,
        amount: Number(data.amount),
        toAddress: data.address,
      }),
    }),
  confirmWithdrawal: (wid: string, token: string) =>
    apiRequest<{ id: string; status: WithdrawalStatus }>('/wallet/withdraw/confirm', {
      method: 'POST',
      body: JSON.stringify({ wid, token }),
    }),
  cancelWithdrawal: (wid: string, cancelToken: string) =>
    apiRequest<{ id: string; status: WithdrawalStatus }>('/wallet/withdraw/cancel', {
      method: 'POST',
      body: JSON.stringify({ wid, cancelToken }),
    }),
  resendWithdrawalConfirmation: (id: string) =>
    apiRequest<{ resendCount: number; maxResends: number }>(
      `/wallet/withdrawals/${id}/resend-confirmation`,
      { method: 'POST' },
    ),
  getTrustedAddresses: () =>
    apiRequest<TrustedAddress[]>('/wallet/trusted-addresses'),
  addTrustedAddress: (data: { coin: string; network: string; address: string; label: string }) =>
    apiRequest<TrustedAddress>('/wallet/trusted-addresses', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeTrustedAddress: (id: string) =>
    apiRequest<void>(`/wallet/trusted-addresses/${id}`, { method: 'DELETE' }),
  getLiveFee: (coin: string, network: string) =>
    apiRequest<{ networkFee: string; platformFee: string; coin: string; network: string }>(
      `/wallet/live-fee?coin=${encodeURIComponent(coin)}&network=${encodeURIComponent(network)}`,
    ),
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
  // Buyer: upload payment proof (transitions payment_pending → payment_uploaded)
  uploadPaymentProof: (id: string, paymentProofUrl: string) =>
    apiRequest<Trade>(`/trades/${id}/payment-proof`, { method: 'POST', body: JSON.stringify({ paymentProofUrl }) }),
  // Seller: confirm payment received (transitions payment_uploaded → payment_confirmed)
  confirmPayment: (id: string) =>
    apiRequest<Trade>(`/trades/${id}/confirm-payment`, { method: 'POST' }),
  // Seller: mark crypto sent with txHash (transitions payment_confirmed → crypto_sent)
  markCryptoSent: (id: string, txHash: string) =>
    apiRequest<Trade>(`/trades/${id}/crypto-sent`, { method: 'POST', body: JSON.stringify({ txHash }) }),
  // Buyer: release escrow (transitions crypto_sent → crypto_released)
  releaseCrypto: (id: string) =>
    apiRequest<Trade>(`/trades/${id}/release`, { method: 'POST' }),
  cancelTrade: (id: string, reason: string) =>
    apiRequest<Trade>(`/trades/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  openDispute: (id: string, data: { reason: string }) =>
    apiRequest<Trade>(`/trades/${id}/dispute`, { method: 'POST', body: JSON.stringify(data) }),
  rateTrade: (id: string, data: { rating: number; comment?: string; tags?: string[] }) =>
    apiRequest<void>(`/trades/${id}/rate`, { method: 'POST', body: JSON.stringify(data) }),
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
    apiRequest<{ status: string; level: string | null; latestSubmission: KycDocument | null }>('/kyc/status'),
  submit: (data: {
    tier: 'basic' | 'enhanced'
    cnicNumber: string
    frontUrl: string
    backUrl: string
    selfieUrl: string
    socialLinks?: Array<{ platform: string; url: string }>
  }) =>
    apiRequest<KycDocument>('/kyc/submit', { method: 'POST', body: JSON.stringify(data) }),
  getSubmissions: () =>
    apiRequest<{ submissions: KycDocument[] }>('/kyc/submissions'),
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
    return apiRequest<{
      notifications: Notification[]
      unreadCount: number
      pagination: { page: number; limit: number; total: number; pages: number }
    }>('/notifications' + qs)
  },
  markRead: (id: string) =>
    apiRequest<void>(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () =>
    apiRequest<void>('/notifications/read-all', { method: 'PATCH' }),
  getUnreadCount: () =>
    apiRequest<{ count: number }>('/notifications/unread-count'),
}

export const dashboardApi = {
  getSummary: () =>
    apiRequest<{
      wallets: WalletBalance[]
      tradeStats: {
        completedTrades: number
        totalTrades: number
        completionRate: number | null
        totalVolumePKR: string | null
        badge: string | null
        badgeLabel: string | null
      } | null
    }>('/dashboard/summary'),
  getRecentActivity: () =>
    apiRequest<{ activities: Array<{ type: string; description: string; createdAt: string }> }>('/dashboard/activity'),
}

export const merchantsApi = {
  apply: (data: {
    businessName: string
    description: string
    proofUrl?: string
    cnicFrontUrl?: string
    cnicBackUrl?: string
    selfieUrl?: string
  }) =>
    apiRequest<{ id: string; status: string }>('/merchants/apply', { method: 'POST', body: JSON.stringify(data) }),
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
    apiRequest<{ orderId: string; status: string; paymentInstructions: Record<string, string> }>('/instant-buy/orders', { method: 'POST', body: JSON.stringify(data) }),
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
  getTop: (params?: { period?: string; limit?: number }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{
      entries: Array<{
        rank: number
        userId: string
        username: string
        badge?: string | null
        badgeLabel?: string | null
        totalTrades?: number | null
        completedTrades?: number | null
        completionRate?: number | null
        avgRating?: number | null
        totalVolumePKR?: string | number | null
        trustScore?: number | null
      }>
    }>('/leaderboard' + qs)
  },
}

export const usersApi = {
  getProfile: (username: string) =>
    apiRequest<Partial<AuthUser>>(`/users/${username}`),
  search: (query: string) =>
    apiRequest<{ users: Array<Partial<AuthUser>> }>(`/users/search?q=${encodeURIComponent(query)}`),
}

// ─── Gas types ────────────────────────────────────────────────────────────────

export interface GasChain {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl: string | null
  category: string
  networkLabel: string
  addressType: string
  isActive: boolean
  isAvailable: boolean
  tokenCount: number
}

export interface GasToken {
  id: string
  name: string
  symbol: string
  tokenType: string
  logoUrl: string | null
  priceSymbol: string
  priceUsd: number
  pricePkr: number
  markup: number
  minAmount: number
  maxUsdValue: number
  presetAmounts: number[]
  isActive: boolean
  rateStale: boolean
}

export interface GasTokensResponse {
  chain: {
    id: string
    slug: string
    name: string
    symbol: string
    networkLabel: string
    addressType: string
    explorerBase: string | null
  }
  tokens: GasToken[]
  updatedAt: string
}

export interface GasOrder {
  id?: string
  orderRef: string
  status: 'payment_pending' | 'payment_uploaded' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'refund_pending' | 'refunded'
  toAddress: string
  tier?: string | null
  chain: string
  paymentAddress: string
  paymentAmount: string
  paymentCoin?: string
  paymentNetwork: string
  pkrAmount?: string | null
  pkrPaymentMethod?: string | null
  paymentProofUrl?: string | null
  gasAmountNative: string
  nativeSymbol?: string
  deliveryTxHash?: string
  expiresAt: string
  createdAt?: string
  gasTokenConfig?: { name: string; symbol: string; logoUrl?: string | null } | null
}

export interface GasPkrMethods {
  bank: { bankName: string | null; accountName: string | null; iban: string | null; accountNumber: string | null }
  easypaisa: { number: string | null; name: string | null }
  jazzcash: { number: string | null; name: string | null }
}

export interface GasCryptoMethods {
  bep20: { address: string | null; network: string; fee: string }
  aptos: { address: string | null; network: string; fee: string }
}

export interface GasCustomRequest {
  id: string
  blockchainName: string
  token: string
  amount: string | null
  purpose: string
  urgency: string
  details: string | null
  contactEmail: string | null
  ipAddress: string | null
  status: 'pending' | 'reviewing' | 'completed' | 'rejected'
  adminNotes: string | null
  createdAt: string
  updatedAt: string
}

export const gasApi = {
  getChains: () =>
    apiRequest<{ chains: GasChain[] }>('/gas-fee/chains'),

  getChainTokens: (chainSlug: string) =>
    apiRequest<GasTokensResponse>(`/gas-fee/chains/${chainSlug}/tokens`),

  createOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders', { method: 'POST', body: JSON.stringify(data) }),

  createPkrOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; pkrPaymentMethod: 'bank_transfer' | 'easypaisa' | 'jazzcash'; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/pkr', { method: 'POST', body: JSON.stringify(data) }),

  createCryptoOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; paymentNetwork: 'BEP20' | 'APTOS'; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/crypto', { method: 'POST', body: JSON.stringify(data) }),

  submitProof: (orderRef: string, proofUrl: string) =>
    apiRequest<{ orderRef: string; status: string }>(`/gas-fee/orders/${orderRef}/proof`, { method: 'POST', body: JSON.stringify({ proofUrl }) }),

  getOrder: (orderRef: string) =>
    apiRequest<GasOrder>(`/gas-fee/orders/${orderRef}`),

  getPkrMethods: () =>
    apiRequest<GasPkrMethods>('/gas-fee/pkr-methods'),

  getCryptoMethods: () =>
    apiRequest<GasCryptoMethods>('/gas-fee/crypto-methods'),

  submitCustomRequest: (data: { blockchainName: string; token: string; amount?: string; purpose: string; urgency: string; details?: string; contactEmail?: string }) =>
    apiRequest<{ message: string }>('/gas-fee/custom-request', { method: 'POST', body: JSON.stringify(data) }),

  getOrderHistory: (params?: { page?: number; limit?: number }) =>
    apiRequest<{ orders: GasOrder[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/gas-fee/orders/history' + (params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '')),
}

export const gasFeeApi = {
  estimate: (data: { coin: string; network: string }) =>
    apiRequest<{ fee: string; feePkr: string; estimatedTime: string }>('/gas-fee/estimate', { method: 'POST', body: JSON.stringify(data) }),
}

function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as { randomUUID: () => string }).randomUUID()
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function buildQs(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const entries = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  return entries.length ? '?' + new URLSearchParams(entries).toString() : ''
}

// ─── Admin gas config types ───────────────────────────────────────────────────

export interface AdminGasChain {
  id: string
  name: string
  slug: string
  symbol: string
  logoUrl: string | null
  category: string
  networkLabel: string
  addressType: string
  explorerBase: string | null
  backendChainId: string | null
  platformFeePercent: number
  alertThresholdUsd: number | null
  pauseThresholdUsd: number | null
  isActive: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
  tokens?: AdminGasToken[]
  _count?: { tokens: number }
}

export interface AdminGasToken {
  id: string
  chainConfigId: string
  name: string
  symbol: string
  tokenType: string
  contractAddress: string | null
  logoUrl: string | null
  priceSymbol: string
  minAmount: string | number
  maxUsdValue: string | number
  presetAmounts: number[]
  isActive: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
  chain?: { name: string; slug: string }
}

export const adminApi = {
  // Dashboard
  getStats: () =>
    apiRequest<{ totalUsers: number; totalTrades: number; totalVolume: string; pendingKyc: number; openDisputes: number; pendingWithdrawals?: number; pendingInstantBuy?: number; todayRevenuePkr?: string }>('/admin/dashboard/stats'),

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
    apiRequest<{ submissions: unknown[]; total: number }>('/admin/merchants/queue' + buildQs(params)),
  approveMerchantKyc: (id: string) =>
    apiRequest<void>(`/admin/merchants/${id}/approve`, { method: 'POST' }),
  rejectMerchantKyc: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/merchants/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

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
  // Backend returns { withdrawals: [...], pagination: { page, limit, total, pages } }
  getWithdrawals: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ withdrawals: unknown[]; pagination: { page: number; limit: number; total: number; pages: number } }>('/admin/withdrawals' + buildQs(params)),
  approveWithdrawal: (id: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/approve`, { method: 'POST' }),
  rejectWithdrawal: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),
  markWithdrawalSent: (id: string, data: { txHash: string; adminNote?: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/mark-sent`, { method: 'POST', body: JSON.stringify(data) }),
  holdWithdrawal: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/hold`, { method: 'POST', body: JSON.stringify(data) }),
  releaseWithdrawalHold: (id: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/release-hold`, { method: 'POST' }),
  overrideWithdrawalRisk: (id: string, data: { note: string; overrideTier?: number }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/risk-override`, { method: 'POST', body: JSON.stringify(data) }),
  getWithdrawalTiers: () =>
    apiRequest<{ tier1MaxUsd: number; tier2MaxUsd: number; tier3MaxUsd: number; autoApproveEnabled: boolean; firstWithdrawalReview: boolean; newWalletReview: boolean; velocityWindowMins: number; velocityMaxCount: number; coinPricesUsd: Record<string, number> }>('/admin/withdrawal-tiers'),
  updateWithdrawalTiers: (data: Record<string, unknown>) =>
    apiRequest<void>('/admin/withdrawal-tiers', { method: 'PUT', body: JSON.stringify(data) }),

  // Config
  getConfig: () =>
    apiRequest<Array<{ id: string; key: string; value: string; updatedAt: string }>>('/admin/config'),
  updateConfig: (data: { key: string; value: string }) =>
    apiRequest<{ id: string; key: string; value: string; updatedAt: string }>('/admin/config', { method: 'PATCH', body: JSON.stringify(data) }),

  // Analytics
  getAnalytics: (params?: Record<string, string | number | undefined>) =>
    apiRequest<unknown>('/admin/analytics' + buildQs(params)),

  // Wallet
  getWalletStatus: () =>
    apiRequest<{
      depositAddresses: Array<{
        coin: string; network: string; chain: string
        address: string | null; source: 'env' | 'db' | 'mnemonic' | null
        configured: boolean; updatedAt: string | null
      }>
      hotWallets: Array<{
        chain: string; address: string; isActive: boolean
        balance: number | null; balanceUsd: number | null; nativeSymbol: string
        alertThresholdUsd: number | null; pauseThresholdUsd: number | null
        status: 'healthy' | 'low' | 'paused' | 'unavailable'
      }>
      orderSummary: Record<string, number>
      configWarnings: Array<{ key: string; label: string; required: boolean }>
      mnemonicConfigured: boolean
      evmHotWallet: string | null
    }>('/admin/wallet/status'),
  getWalletAddresses: () =>
    apiRequest<Array<{ id: string; key: string; value: string; updatedAt: string }>>('/admin/wallet/addresses'),
  updateWalletAddress: (data: { coin: string; network: string; address: string }) =>
    apiRequest<{ id: string; key: string; value: string; updatedAt: string }>('/admin/wallet/addresses', { method: 'POST', body: JSON.stringify(data) }),
  getPendingPayouts: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ withdrawals: Array<{ id: string; userId: string; user?: { email: string; username: string }; coin: string; amount: string; address: string; network: string; status: string; createdAt: string }>; pagination: { total: number; page: number; limit: number; pages: number } }>('/admin/wallet/pending-payouts' + buildQs(params)),

  // Gas Orders
  getGasOrders: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ orders: unknown[]; pagination: { total: number; page: number; limit: number; pages: number } }>('/admin/gas/orders' + buildQs(params)),
  getGasOrder: (ref: string) =>
    apiRequest<unknown>(`/admin/gas/orders/${ref}`),
  retryGasOrder: (id: string) =>
    apiRequest<void>(`/admin/gas/orders/${id}/retry`, { method: 'POST' }),
  refundGasOrder: (id: string) =>
    apiRequest<void>(`/admin/gas/orders/${id}/refund`, { method: 'POST' }),
  approvePkrOrder: (id: string) =>
    apiRequest<{ status: string }>(`/admin/gas/orders/${id}/approve-pkr`, { method: 'POST' }),
  rejectPkrOrder: (id: string, reason?: string) =>
    apiRequest<{ status: string }>(`/admin/gas/orders/${id}/reject-pkr`, { method: 'POST', body: JSON.stringify({ reason }) }),

  // Gas Custom Requests
  getGasCustomRequests: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ requests: GasCustomRequest[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/admin/gas/custom-requests' + buildQs(params)),
  updateGasCustomRequest: (id: string, data: { status?: GasCustomRequest['status']; adminNotes?: string }) =>
    apiRequest<GasCustomRequest>(`/admin/gas/custom-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Gas Stats & Wallet
  getGasStats: () =>
    apiRequest<{
      todayOrders: number
      todayRevenue: string | number
      pendingCount: number
      failedCount: number
      refundPendingCount: number
      pendingCustomRequests: number
      wallet: {
        chain: string
        address: string
        isActive: boolean
        balance: number | null
        balanceUsd: number | null
        nativeSymbol: string
        status: 'healthy' | 'low' | 'paused' | 'unavailable'
        alertThresholdUsd: number | null
        pauseThresholdUsd: number | null
        lastBalanceRefreshAt: string | null
      } | null
      wallets: Array<{
        chain: string
        address: string
        isActive: boolean
        balance: number | null
        balanceUsd: number | null
        nativeSymbol: string
        status: 'healthy' | 'low' | 'paused' | 'unavailable'
        alertThresholdUsd: number | null
        pauseThresholdUsd: number | null
        lastBalanceRefreshAt: string | null
      }>
    }>('/admin/gas/stats'),
  getGasWallets: () =>
    apiRequest<{ wallets: Array<{ id: string; chain: string; address: string; isActive: boolean; balanceTRX: number | null; isAutoPaused: boolean }> }>('/admin/gas/wallets'),
  updateGasWalletBalance: (chain: string, balanceTRX: number) =>
    apiRequest<void>(`/admin/gas/wallets/${chain}/balance`, { method: 'POST', body: JSON.stringify({ balanceTRX }) }),
  refreshGasWalletBalance: (chain: string) =>
    apiRequest<{ chain: string; balance: number; balanceUsd: number | null; nativeSymbol: string; status: string; alertThresholdUsd: number | null; pauseThresholdUsd: number | null }>(`/admin/gas/wallets/${chain}/refresh-balance`, { method: 'POST' }),
  toggleGasChain: (chain: string) =>
    apiRequest<{ chain: string; isActive: boolean }>(`/admin/gas/chains/${chain}/toggle`, { method: 'POST' }),
  testRpcHealth: (chain: string) =>
    apiRequest<{
      chain: string
      rpc: { reachable: boolean; blockNumber: number | null; latencyMs: number; isStale: boolean; error: string | null }
      signer: { ok: boolean; derivedAddress: string | null; walletAddress: string; addressMatch: boolean | null; error: string | null }
      allClear: boolean
    }>(`/admin/gas/wallets/${chain}/test-rpc`, { method: 'POST' }),
  getGasGlobalPause: () =>
    apiRequest<{ paused: boolean; reason: string | null }>('/admin/gas/global-pause'),
  setGasGlobalPause: (paused: boolean, reason?: string) =>
    apiRequest<{ paused: boolean; reason: string | null }>('/admin/gas/global-pause', { method: 'POST', body: JSON.stringify({ paused, reason }) }),
  getGasAnalytics: (period?: '24h' | '7d' | '30d' | 'all') =>
    apiRequest<{
      period: string
      successCount: number
      failedCount: number
      avgCompletionSec: number | null
      chainStats: Array<{ chain: string; delivered: number; failed: number; total: number; successRate: number | null }>
    }>('/admin/gas/analytics' + (period ? `?period=${period}` : '')),

  // Gas Unattributed Payments
  getGasUnattributed: () =>
    apiRequest<{ payments: unknown[]; total: number }>('/admin/gas/unattributed'),
  attributeGasPayment: (txHash: string, orderId: string) =>
    apiRequest<void>(`/admin/gas/unattributed/${encodeURIComponent(txHash)}/attribute`, { method: 'POST', body: JSON.stringify({ orderId }) }),

  // Gas Chain Config CRUD
  getGasChains: () =>
    apiRequest<{ chains: AdminGasChain[] }>('/admin/gas/chains'),
  createGasChain: (data: Partial<AdminGasChain>) =>
    apiRequest<AdminGasChain>('/admin/gas/chains', { method: 'POST', body: JSON.stringify(data) }),
  updateGasChain: (id: string, data: Partial<AdminGasChain>) =>
    apiRequest<AdminGasChain>(`/admin/gas/chains/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGasChain: (id: string) =>
    apiRequest<void>(`/admin/gas/chains/${id}`, { method: 'DELETE' }),

  // Gas Token Config CRUD
  getGasTokens: (chainId?: string) =>
    apiRequest<{ tokens: AdminGasToken[] }>('/admin/gas/tokens' + (chainId ? `?chainId=${chainId}` : '')),
  createGasToken: (data: Partial<AdminGasToken>) =>
    apiRequest<AdminGasToken>('/admin/gas/tokens', { method: 'POST', body: JSON.stringify(data) }),
  updateGasToken: (id: string, data: Partial<AdminGasToken>) =>
    apiRequest<AdminGasToken>(`/admin/gas/tokens/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGasToken: (id: string) =>
    apiRequest<void>(`/admin/gas/tokens/${id}`, { method: 'DELETE' }),

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
