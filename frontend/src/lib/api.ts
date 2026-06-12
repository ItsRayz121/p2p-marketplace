// In dev, Next.js rewrites /api/* → backend, so we use '' (same-origin).
// In production, we call the Railway backend URL directly.
function resolveApiBase(): string {
  if (process.env.NODE_ENV === 'development') return ''
  const v = process.env.NEXT_PUBLIC_API_URL
  if (!v) {
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.error(
        '[RupChain] NEXT_PUBLIC_API_URL is not set — API calls will hit the current origin and 404. Set it in Vercel → Settings → Environment Variables to your Railway backend URL (no trailing slash, no /api).',
      )
    }
    return ''
  }
  return v.replace(/\/$/, '')
}
const API_BASE = resolveApiBase()

import { useAuthStore } from '../store/auth.store'
import type { AuthUser } from '../store/auth.store'
import { isTelegramMiniApp, getInitData } from './telegram'

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

// Cached CSRF fetch so concurrent requests don't all fire at once
let csrfFetchPromise: Promise<string> | null = null

async function fetchCsrfToken(): Promise<string> {
  if (!csrfFetchPromise) {
    csrfFetchPromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/csrf`, { credentials: 'include' })
        if (res.ok) {
          const raw = await res.json() as { data?: { token: string }; token?: string }
          return raw.data?.token ?? (raw as { token?: string }).token ?? ''
        }
      } catch { /* ignore */ }
      return ''
    })()
    csrfFetchPromise.finally(() => { csrfFetchPromise = null })
  }
  return csrfFetchPromise
}

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

// Re-authenticate from the Telegram launch hash. Telegram's WebView blocks the
// cross-site refresh cookie, so /auth/refresh can't work there — instead we
// re-validate the (always-present) initData. This both bootstraps the very
// first session and silently re-issues an expired access token.
export async function miniAppAuthenticate(): Promise<{ accessToken: string; user: AuthUser; isNew: boolean }> {
  const initData = getInitData()
  // Error messages are intentionally specific (status / no-initData / network)
  // so the Mini App bridge can surface the real reason for debugging instead of
  // a single opaque "couldn't sign you in".
  if (!initData) throw new Error('NO_INITDATA: launch data not found on this device')

  // Many users open the Mini App over a VPN / carrier-grade-NAT mobile
  // connection where a single request can transiently fail or hit a 5xx. The
  // initData is HMAC-validated server-side, so retrying is safe — re-issue a few
  // times with linear backoff before surfacing the "couldn't sign you in" error.
  // A 4xx (bad/stale initData, banned account) is a definitive answer: don't retry.
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/api/v1/miniapp/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
        credentials: 'include',
      })
    } catch (networkErr) {
      if (attempt === maxAttempts) {
        throw new Error(`NETWORK: ${networkErr instanceof Error ? networkErr.message : 'request failed'}`)
      }
      await new Promise((r) => setTimeout(r, 700 * attempt))
      continue
    }
    if (res.status >= 500 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 700 * attempt))
      continue
    }
    if (!res.ok) throw new Error(`HTTP_${res.status}: server rejected launch data`)
    const raw = await res.json()
    return unwrapEnvelope<{ accessToken: string; user: AuthUser; isNew: boolean }>(raw)
  }
  throw new Error('Mini App authentication failed')
}

// Choose the right re-auth strategy: launch-hash initData inside Telegram,
// refresh cookie on the web. Used by the 401 retry path.
async function reauth(): Promise<string> {
  if (isTelegramMiniApp()) {
    const data = await miniAppAuthenticate()
    useAuthStore.getState().setUser(data.user)
    return data.accessToken
  }
  return doRefresh()
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const url = `${API_BASE}/api/v1${path}`

  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  }
  // Only set Content-Type for JSON bodies — let the browser set it automatically for FormData
  // (FormData needs multipart/form-data with boundary, which the browser generates)
  if (options?.body !== undefined && options.body !== null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  // Attach access token from store
  const token = useAuthStore.getState().accessToken
  if (token) headers['Authorization'] = 'Bearer ' + token

  // Attach CSRF token for unsafe methods — auto-fetch if not yet cached
  if (UNSAFE_METHODS.has(method)) {
    let csrf = useAuthStore.getState().csrfToken
    if (!csrf) {
      csrf = await fetchCsrfToken()
      if (csrf) useAuthStore.getState().setCsrfToken(csrf)
    }
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

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
        const newToken = await reauth()
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

    // TOTP step-up — the backend demands a 2FA code for this action. Prompt
    // for the code and retry once with it attached. Flows with their own
    // inline TOTP field (wallet withdraw / trusted address) pre-send the
    // header, so this prompt only fires for flows without one (admin actions).
    if (res.status === 403 && (data as { error?: string }).error === 'TOTP_REQUIRED' && typeof window !== 'undefined') {
      const code = window.prompt('This action requires your 2FA code.\nEnter the 6-digit code from your authenticator app:')
      if (code && /^\d{6}$/.test(code.trim())) {
        headers['X-TOTP-Code'] = code.trim()
        const retryController = new AbortController()
        const retryTimeout = setTimeout(() => retryController.abort(), 15_000)
        try {
          const retryRes = await fetch(url, { ...options, method, headers, credentials: 'include', signal: retryController.signal })
          const retryData = await retryRes.json()
          if (!retryRes.ok) {
            throw new ApiError(
              (retryData as { error?: string }).error ?? 'UNKNOWN_ERROR',
              (retryData as { message?: string }).message ?? 'An error occurred',
              retryRes.status,
            )
          }
          return unwrapEnvelope<T>(retryData)
        } finally {
          clearTimeout(retryTimeout)
        }
      }
    }

    // Stale CSRF token — refresh and retry the original request once
    if (res.status === 403 && (data as { error?: string }).error === 'INVALID_CSRF_TOKEN') {
      invalidateCsrfToken()
      const freshCsrf = await fetchCsrfToken()
      if (freshCsrf) {
        useAuthStore.getState().setCsrfToken(freshCsrf)
        headers['X-CSRF-Token'] = freshCsrf
        const retryController = new AbortController()
        const retryTimeout = setTimeout(() => retryController.abort(), 15_000)
        try {
          const retryRes = await fetch(url, { ...options, method, headers, credentials: 'include', signal: retryController.signal })
          const retryData = await retryRes.json()
          if (!retryRes.ok) {
            throw new ApiError(
              (retryData as { error?: string }).error ?? 'UNKNOWN_ERROR',
              (retryData as { message?: string }).message ?? 'An error occurred',
              retryRes.status,
            )
          }
          return unwrapEnvelope<T>(retryData)
        } finally {
          clearTimeout(retryTimeout)
        }
      }
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

export type AdminNotifCategory = 'KYC' | 'TRADE' | 'GAS' | 'DISPUTE' | 'CTM' | 'SYSTEM'

export interface AdminNotif {
  id: string
  category: AdminNotifCategory
  title: string
  body: string
  href: string | null
  isRead: boolean
  metadata: Record<string, unknown>
  createdAt: string
}

export interface Trade {
  id: string
  orderRef?: string
  adId: string
  buyerId: string
  sellerId: string
  coin: string
  network?: string
  amount: string
  price: string
  /** Alias for fiatAmount — backend may return either */
  totalPkr: string
  fiatAmount?: string
  status: 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed' | 'expired'
  paymentMethod: string
  paymentProofUrl?: string
  buyerWalletAddress?: string
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  sellerTxHash?: string
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
  side: 'buy' | 'sell'
  coin: string
  network: string
  priceType: 'fixed' | 'float'
  price: string
  floatOffset: string
  totalAmount: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  tradeWindow: number
  terms?: string
  status: 'active' | 'paused' | 'completed'
  createdAt: string
  updatedAt: string
  user?: Partial<AuthUser>
}

export interface CreateAdPayload {
  side: 'buy' | 'sell'
  coin: string
  network: string
  priceType: 'fixed' | 'float'
  price: number
  floatOffset?: number
  totalAmount?: number
  minOrder: number
  maxOrder: number
  paymentMethods: string[]
  tokenDeliveryTypes?: string[]
  settlementMethod?: string
  tradeWindow?: number
  terms?: string
}

export interface UpdateAdPayload {
  price?: number
  floatOffset?: number
  minOrder?: number
  maxOrder?: number
  availableAmount?: number
  paymentMethods?: string[]
  tradeWindow?: number
  terms?: string
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
    fullName: string | null
    avatarUrl: string | null
    badge: string
    lastSeenAt: string | null
    joinedAt?: string | null
    isMerchant: boolean
    merchantId: string | null
    merchantName: string | null
    tradeStats: {
      completionRate: string
      totalTrades: number
      completedTrades: number
      avgRating: string
      avgResponseMinutes: number | null
      avgReleaseMinutes: number | null
      totalVolumePKR: string | null
      totalReviews: number | null
    } | null
    hasCollateral: boolean
  }
}

export interface RecentTrade {
  id: string
  amount: string
  coin: string
  completedAt: string
  buyerUsername: string
  sellerUsername: string
  buyerFullName?: string | null
  sellerFullName?: string | null
}

export interface MarketRateToken {
  symbol: string
  name: string
  slug: string
  averageUsdtRate: number | null
  averagePkrRate: number | null
  listingCount: number
}

export interface MarketRatesSummary {
  usdt: { averagePkrRate: number | null; listingCount: number }
  communityTokens: MarketRateToken[]
  gasFees: MarketRateToken[]
  updatedAt: string
}

export interface KycDocument {
  id: string
  userId: string
  tier: 'basic' | 'enhanced'
  status: 'pending' | 'approved' | 'rejected' | 'needs_revision'
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  videoUrl?: string | null
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
  network: string
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
  txHash?: string
  metadata?: Record<string, unknown>
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
  register: (data: { email: string; fullName: string; password: string; referralCode?: string; intendedRole?: 'user' | 'merchant'; turnstileToken?: string }) =>
    apiRequest<{ userId: string; email: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  verifyEmail: (data: { email: string; code: string }) =>
    apiRequest<{ message: string; accessToken: string; user: AuthUser }>('/auth/verify-email', { method: 'POST', body: JSON.stringify(data) }),
  resendOtp: (email: string, type: 'verify' | 'reset' = 'verify') =>
    apiRequest<{ sent: boolean }>('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email, type }) }),
  login: (data: { email: string; password: string; rememberMe?: boolean; turnstileToken?: string }) =>
    apiRequest<{
      accessToken?: string
      preAuthToken?: string
      user?: AuthUser
      restricted?: { status: 'banned' | 'suspended'; reason: string | null; until: string | null; appealToken: string }
    }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
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
  updateAvatar: (avatarUrl: string) =>
    apiRequest<AuthUser>('/upload/avatar', { method: 'PATCH', body: JSON.stringify({ avatarUrl }) }),
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

// Account linking — connect a real email and/or a Telegram identity to the
// signed-in account (Settings → Connections).
export const accountApi = {
  startEmailLink: (email: string) =>
    apiRequest<{ message: string }>('/account/email/start', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  verifyEmailLink: (data: { email: string; code: string; password?: string }) =>
    apiRequest<AuthUser>('/account/email/verify', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createTelegramLinkToken: () =>
    apiRequest<{ deepLink: string | null; expiresAt: string }>('/account/telegram/link-token', {
      method: 'POST',
    }),
}

export const marketplaceApi = {
  getRate: (coin: string) =>
    apiRequest<{ rate: number; updatedAt: string; source: string }>(`/marketplace/rate/${coin}`),
  getRates: () =>
    apiRequest<{ rates: Record<string, number>; updatedAt: string; source: string }>('/marketplace/rates'),
  getStats: () =>
    apiRequest<{ totalUsers: number; totalTrades: number; totalVolume: string; verifiedTraders: number; todayTrades: number }>('/marketplace/stats'),
  getTopAds: () =>
    apiRequest<{ buys: MarketplaceAd[]; sells: MarketplaceAd[] }>('/marketplace/top-ads'),
  getConfig: () =>
    apiRequest<Record<string, unknown>>('/marketplace/config'),
  getRecentTrades: () =>
    apiRequest<RecentTrade[]>('/marketplace/recent-trades'),
  getMarketRatesSummary: () =>
    apiRequest<MarketRatesSummary>('/marketplace/rates/summary'),
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

export const favoritesApi = {
  getFavorites: () =>
    apiRequest<unknown[]>('/users/me/favorites'),
  addFavorite: (username: string) =>
    apiRequest<{ isFavorited: boolean }>(`/users/${encodeURIComponent(username)}/favorite`, { method: 'POST' }),
  removeFavorite: (username: string) =>
    apiRequest<{ isFavorited: boolean }>(`/users/${encodeURIComponent(username)}/favorite`, { method: 'DELETE' }),
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
  requestWithdrawal: (data: { coin: string; amount: string; address: string; network: string; totpCode?: string }) =>
    apiRequest<{ id: string; status: WithdrawalStatus; orderRef: string }>('/wallet/withdraw', {
      method: 'POST',
      headers: {
        'X-Idempotency-Key': cryptoRandomId(),
        ...(data.totpCode ? { 'X-TOTP-Code': data.totpCode } : {}),
      },
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
  addTrustedAddress: (data: { coin: string; network: string; address: string; label: string; totpCode?: string }) =>
    apiRequest<TrustedAddress>('/wallet/trusted-addresses', {
      method: 'POST',
      headers: data.totpCode ? { 'X-TOTP-Code': data.totpCode } : {},
      body: JSON.stringify({ coin: data.coin, network: data.network, address: data.address, label: data.label }),
    }),
  removeTrustedAddress: (id: string) =>
    apiRequest<void>(`/wallet/trusted-addresses/${id}`, { method: 'DELETE' }),
  getLiveFee: (coin: string, network: string) =>
    apiRequest<{ networkFee: string; platformFee: string; gasFee: string; coin: string; network: string }>(
      `/wallet/live-fee?coin=${encodeURIComponent(coin)}&network=${encodeURIComponent(network)}`,
    ),
  getSavedAddresses: () =>
    apiRequest<SavedDeliveryAddress[]>('/wallet/saved-addresses'),
  addSavedAddress: (data: { coin: string; network: string; address: string; label: string }) =>
    apiRequest<SavedDeliveryAddress>('/wallet/saved-addresses', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteSavedAddress: (id: string) =>
    apiRequest<void>(`/wallet/saved-addresses/${id}`, { method: 'DELETE' }),
}

export const tradesApi = {
  createTrade: (data: { adId: string; amount: number | string; paymentMethod: string; buyerDeliveryMethod?: string; buyerDeliveryAddress?: string }) =>
    apiRequest<Trade>('/trades', { method: 'POST', body: JSON.stringify({ ...data, amount: typeof data.amount === 'string' ? parseFloat(data.amount) : data.amount }) }),
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
  openDispute: (id: string, data: { reason: string; description: string }) =>
    apiRequest<Trade>(`/trades/${id}/dispute`, { method: 'POST', body: JSON.stringify(data) }),
  rateTrade: (id: string, data: { rating: number; comment?: string; tags?: string[] }) =>
    apiRequest<void>(`/trades/${id}/rate`, { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (id: string, message: string) =>
    apiRequest<{ id: string; message: string; createdAt: string }>(`/trades/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) }),
  getMessages: (id: string) =>
    apiRequest<{ messages: Array<{ id: string; senderId: string; message: string; createdAt: string }> }>(`/trades/${id}/messages`),
}

export interface AdBid {
  id: string
  adId: string
  bidderId: string
  pricePerUnit: string
  usdtAmount: string
  fiatAmount: string
  message?: string | null
  paymentMethod?: string | null
  buyerUsdtAddress?: string | null
  status: string
  expiresAt: string
  createdAt: string
  bidder?: { id: string; username: string }
  trade?: { orderRef: string; status: string } | null
  ad?: Ad & { user: { id: string; username: string } }
}

export interface AdActivity {
  myBid?: { id: string; status: string; expiresAt: string; pricePerUnit: string; usdtAmount: string; fiatAmount: string } | null
  bids: { pendingCount: number; minPrice: string | null; maxPrice: string | null; items?: AdBid[] }
  trades: { activeCount: number; completedCount: number; lastTradePrice: string | null; lastTradeAt: string | null; items?: Array<{ id: string; orderRef: string; status: string; amount: string; price: string; fiatAmount: string; createdAt: string; buyer: { username: string; fullName?: string | null }; seller: { username: string; fullName?: string | null } }> }
}

export const adsApi = {
  createAd: (data: CreateAdPayload) =>
    apiRequest<Ad>('/ads', { method: 'POST', body: JSON.stringify(data) }),
  updateAd: (id: string, data: UpdateAdPayload) =>
    apiRequest<Ad>(`/ads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAd: (id: string) =>
    apiRequest<void>(`/ads/${id}`, { method: 'DELETE' }),
  getAd: (id: string) =>
    apiRequest<Ad & { resolvedPaymentMethods: Array<{ id: string; type: string; label: string }>; user: { id: string; username: string; tradeStats?: { totalTrades: number; completedTrades: number; completionRate: string } | null } }>(`/ads/${id}`),
  getMyAds: (params?: { page?: number; limit?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ items: Ad[]; total: number; page: number; limit: number; totalPages: number }>('/ads/me' + qs)
  },
  pauseAd: (id: string) =>
    apiRequest<Ad>(`/ads/${id}/pause`, { method: 'POST' }),
  activateAd: (id: string) =>
    apiRequest<Ad>(`/ads/${id}/activate`, { method: 'POST' }),
  getAdActivity: (id: string) =>
    apiRequest<AdActivity>(`/ads/${id}/activity`),
  placeBid: (adId: string, data: { pricePerUnit: number; usdtAmount: number; message?: string }) =>
    apiRequest<AdBid>(`/ads/${adId}/bids`, { method: 'POST', body: JSON.stringify(data) }),
  acceptBid: (bidId: string) =>
    apiRequest<{ status: string; bidId: string; expiresAt: string }>(`/ads/bids/${bidId}/accept`, { method: 'POST' }),
  rejectBid: (bidId: string) =>
    apiRequest<void>(`/ads/bids/${bidId}/reject`, { method: 'POST' }),
  cancelBid: (bidId: string) =>
    apiRequest<void>(`/ads/bids/${bidId}/cancel`, { method: 'POST' }),
  confirmBidDetails: (bidId: string, data: { paymentMethod: string; buyerUsdtAddress?: string }) =>
    apiRequest<{ id: string; orderRef: string }>(`/ads/bids/${bidId}/confirm`, { method: 'POST', body: JSON.stringify(data) }),
  getMyBids: (params?: { page?: number; limit?: number }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ bids: AdBid[]; total: number; page: number; limit: number }>('/ads/bids/mine' + qs)
  },
}

export interface UserPaymentMethod {
  id: string
  userId: string
  type: 'jazzcash' | 'easypaisa' | 'sadapay' | 'nayapay' | 'bank_transfer'
  displayName: string
  accountName: string
  mobileNumber?: string | null
  bankName?: string | null
  ibanNumber?: string | null
  accountNumber?: string | null
  isActive: boolean
  createdAt: string
}

export const userPaymentMethodsApi = {
  getAll: () =>
    apiRequest<UserPaymentMethod[]>('/users/me/payment-methods'),
  add: (data: {
    type: UserPaymentMethod['type']
    displayName: string
    accountName: string
    mobileNumber?: string
    bankName?: string
    ibanNumber?: string
    accountNumber?: string
  }) =>
    apiRequest<UserPaymentMethod>('/users/me/payment-methods', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  remove: (id: string) =>
    apiRequest<void>(`/users/me/payment-methods/${id}`, { method: 'DELETE' }),
}

export interface SavedDeliveryAddress {
  id: string
  coin: string
  network: string   // 'BEP20' | 'Aptos' | 'Binance' | 'Bitget' | 'Gate'
  address: string
  label: string
}

export const kycApi = {
  getStatus: () =>
    apiRequest<{ status: string; level: string | null; latestSubmission: KycDocument | null }>('/kyc/status'),
  submit: (data: {
    tier: 'basic' | 'enhanced'
    // CNIC + document photos are required for Basic only; Enhanced reuses the
    // approved Level 1 documents server-side.
    cnicNumber?: string
    frontUrl?: string
    backUrl?: string
    selfieUrl?: string
    videoUrl?: string
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
        trustScore: number | null
      } | null
    }>('/dashboard/summary'),
  getRecentActivity: () =>
    apiRequest<{ activities: Array<{ type: string; description: string; createdAt: string }> }>('/dashboard/activity'),
  getTradingAnalytics: () =>
    apiRequest<TradingAnalytics>('/dashboard/trading-analytics'),
}

export interface TradingAnalytics {
  combined: { totalTrades: number; completedTrades: number; completionRate: number | null; totalVolumePkr: string }
  usdt: { totalTrades: number; completedTrades: number; volumePkr: string }
  ctm: { totalTrades: number; completedTrades: number; volumePkr: string; tier: string | null; avgRating: string | null; isMerchant: boolean }
  gas: { totalOrders: number; deliveredOrders: number; spentUsd: string }
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
    apiRequest<{
      id: string
      businessName: string
      status: string
      rank: string
      approvedAt: string | null
      createdAt: string
      user: {
        id: string
        username: string
        fullName: string | null
        avatarUrl: string | null
        createdAt: string
        tradeStats: {
          totalTrades: number
          completedTrades: number
          completionRate: number
          avgRating: number
          totalReviews: number
          badge: string
          totalVolumePKR: string
        } | null
      }
    }>(`/merchants/${id}`),
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
  getMyOrders: (params?: { limit?: number; status?: string }) => {
    const qs = params
      ? '?' + new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()
      : ''
    return apiRequest<{ orders: Array<{ id: string; status: string; coin: string; amount: string; amountPkr: string; createdAt: string }>; total: number }>('/instant-buy/orders' + qs)
  },
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
  getTop: (params?: { period?: string; limit?: number; tradeType?: string }) => {
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

export interface GasChainBadge {
  label: string
  color: string
}

export interface GasChainCapabilities {
  supportsMnemonic: boolean
  supportsAutoDelivery: boolean
  supportsStablecoins: boolean
  supportsRefunds: boolean
  supportsMonitoring: boolean
  supportsRpcHealthCheck: boolean
  supportsDryRun: boolean
}

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
  readinessState: string
  badge: GasChainBadge
  publiclyVisible: boolean
  orderable: boolean
  capabilities: GasChainCapabilities
}

export interface GasToken {
  id: string
  name: string
  symbol: string
  tokenType: string
  logoUrl: string | null
  priceSymbol: string
  /** Raw live market USD price — no markup applied */
  rawUsdPrice: number
  /** Alias for rawUsdPrice — kept for backward compat */
  priceUsd: number
  pricePkr: number
  /** Fixed platform fee in USDT per order (set by admin per chain) */
  platformFeeUsdt: number
  /** Which data source provided this price: coingecko / bybit / kraken / binance / cache / stale-cache */
  priceSource?: string
  priceUpdatedAt?: string | null
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
  userId?: string | null
  orderRef: string
  trackingToken?: string | null
  status: 'payment_pending' | 'payment_uploaded' | 'payment_verified' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'refund_pending' | 'refunded' | 'cancelled'
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
  paymentTxHash?: string | null
  gasAmountNative: string
  nativeSymbol?: string
  deliveryTxHash?: string
  refundTxHash?: string | null
  expiresAt: string
  createdAt?: string
  gasTokenConfig?: { name: string; symbol: string; logoUrl?: string | null } | null
}

export interface GasPkrMethods {
  bank:      { bankName: string | null; accountName: string | null; iban: string | null; accountNumber: string | null; logoUrl: string | null }
  easypaisa: { number: string | null; name: string | null; logoUrl: string | null }
  jazzcash:  { number: string | null; name: string | null; logoUrl: string | null }
  nayapay:   { number: string | null; name: string | null; logoUrl: string | null }
  sadapay:   { number: string | null; name: string | null; logoUrl: string | null }
}

export interface GasCryptoNetworkMethod {
  address: string | null
  network: string
  fee: string
  feeNativeDisplay?: string
  feeUsd: number
  feeIsLive?: boolean
  logoUrl?: string | null
}

export interface GasFinancialKpi {
  totalOrders: number
  paymentReceivedUsdt: number
  paymentReceivedPkr: number
  gasSpentUsdt: number
  gasSpentPkr: number
  refundCostUsdt: number
  refundCostPkr: number
  netProfitUsdt: number
  netProfitPkr: number
  marginPct: number
  usdPkrRate: number
}

export interface GasCryptoMethods {
  trc20: GasCryptoNetworkMethod
  bep20: GasCryptoNetworkMethod
  erc20: GasCryptoNetworkMethod
  aptos: GasCryptoNetworkMethod
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

export interface GasNetworkFee {
  supported: boolean
  model?: 'gas' | 'bandwidth'
  symbol?: string
  gasPriceGwei?: number
  gasLimit?: number
  estimatedFeeNative?: number
  estimatedFeeUsd?: number | null
  note?: string
}

export const gasApi = {
  getChains: () =>
    apiRequest<{ chains: GasChain[] }>('/gas-fee/chains'),

  getChainTokens: (chainSlug: string) =>
    apiRequest<GasTokensResponse>(`/gas-fee/chains/${chainSlug}/tokens`),

  createOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders', { method: 'POST', body: JSON.stringify(data) }),

  createPkrOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; pkrPaymentMethod: 'bank_transfer' | 'easypaisa' | 'jazzcash' | 'nayapay' | 'sadapay'; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/pkr', { method: 'POST', body: JSON.stringify(data) }),

  createCryptoOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; paymentNetwork: 'TRC20' | 'BEP20' | 'ERC20' | 'APTOS'; idempotencyKey?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/crypto', { method: 'POST', body: JSON.stringify(data) }),

  submitProof: (orderRef: string, proofUrl: string) =>
    apiRequest<{ orderRef: string; status: string }>(`/gas-fee/orders/${orderRef}/proof`, { method: 'POST', body: JSON.stringify({ proofUrl }) }),

  getOrder: (orderRef: string, trackingToken?: string) =>
    apiRequest<GasOrder>(`/gas-fee/orders/${orderRef}${trackingToken ? `?token=${encodeURIComponent(trackingToken)}` : ''}`),

  getPkrMethods: () =>
    apiRequest<GasPkrMethods>('/gas-fee/pkr-methods'),

  getCryptoMethods: () =>
    apiRequest<GasCryptoMethods>('/gas-fee/crypto-methods'),

  submitCustomRequest: (data: { blockchainName: string; token: string; amount?: string; purpose: string; urgency: string; details?: string; contactEmail?: string }) =>
    apiRequest<{ message: string }>('/gas-fee/custom-request', { method: 'POST', body: JSON.stringify(data) }),

  getOrderHistory: (params?: { page?: number; limit?: number }) =>
    apiRequest<{ orders: GasOrder[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>('/gas-fee/orders/history' + (params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '')),

  getNetworkFee: (chainSlug: string) =>
    apiRequest<GasNetworkFee>(`/gas-fee/chains/${chainSlug}/network-fee`),

  verifyPayment: (orderRef: string, txHash: string) =>
    apiRequest<{ status: string; message: string }>(`/gas-fee/orders/${orderRef}/verify-payment`, { method: 'POST', body: JSON.stringify({ txHash }) }),

  getCancelPreview: (orderRef: string, trackingToken?: string) =>
    apiRequest<{ cancellable: boolean; priorCancels: number; thisCancelNumber: number; cooldownMs: number; cooldownLabel: string | null }>(
      `/gas-fee/orders/${orderRef}/cancel-preview${trackingToken ? `?token=${encodeURIComponent(trackingToken)}` : ''}`),

  cancelOrder: (orderRef: string, trackingToken?: string) =>
    apiRequest<{ orderRef: string; status: string; cancelNumber: number; cooldownLabel: string | null; cooldownUntil: string | null }>(
      `/gas-fee/orders/${orderRef}/cancel`, { method: 'POST', body: JSON.stringify(trackingToken ? { token: trackingToken } : {}) }),
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

// ── Deposit Chain Registry ────────────────────────────────────────────────────

export interface AdminDepositChain {
  id: string
  slug: string
  chainId: number | null
  name: string
  family: string
  nativeSymbol: string
  networkLabel: string
  minConfirmations: number
  explorerBase: string
  rpcEnvVar: string | null
  isActive: boolean
  activeTokens: number
  createdAt?: string
  updatedAt?: string
}

export interface AdminDepositToken {
  id: string
  chainId: string
  symbol: string
  address: string | null
  decimals: number
  isActive: boolean
  coingeckoId: string | null
  trustWalletVerified: boolean
  onChainVerified: boolean
  verifiedAt: string | null
  createdAt?: string
  updatedAt?: string
}

export interface ChainSearchResult {
  chainId: number
  name: string
  slug: string
  nativeSymbol: string
  networkLabel: string
  explorerBase: string | null
  publicRpc: string | null
}

export interface RpcHealthSuggestion {
  family: string
  envVar: string | null
  recommended: Array<{ url: string; label: string }>
  configuredHealth: { reachable: boolean; latencyMs: number; error?: string } | null
}

export interface TokenLookupResult {
  symbol: string
  chainSlug: string
  chainName: string
  address: string | null
  decimals: number | null
  name: string | null
  logoUrl: string | null
  checkedAt: string
  coingeckoVerified: boolean
  coingeckoError: string | null
  onChainSupported: boolean
  onChainVerified: boolean
  onChainSymbol: string | null
  onChainDecimals: number | null
  onChainError: string | null
  trustWalletVerified: boolean
  trustWalletError: string | null
  geckoTerminalVerified: boolean
  geckoTerminalError: string | null
}

export interface TokenIdentifyDeployment {
  platformId: string
  chainName: string
  mappedSlug: string | null
  supported: boolean
  address: string
  decimals: number | null
}

export interface TokenIdentifyResult {
  query: string
  resolved: boolean
  error?: string
  kind?: 'token' | 'native_chain' | 'unknown'
  coinId?: string | null
  name?: string | null
  symbol?: string | null
  logoUrl?: string | null
  nativeChain?: { platformId: string; name: string } | null
  deployments?: TokenIdentifyDeployment[]
  verdict?: string
}

export interface TokenAddressLookupResult {
  address: string
  name: string | null
  symbol: string | null
  decimals: number | null
  logoUrl: string | null
  onChainVerified: boolean
  coingeckoVerified: boolean
  errors: string[]
}

export interface GasChainLookupResult {
  suggestedName: string
  suggestedSlug: string
  suggestedSymbol: string
  suggestedCategory: string
  suggestedAddressType: string
  suggestedNetworkLabel: string
  suggestedExplorerBase: string
  suggestedLogoUrl: string
  suggestedEvmChainId: number | null
  confidence: 'high' | 'partial' | 'low'
  warnings: string[]
}

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
  platformFeeUsdt: number
  alertThresholdUsd: number | null
  pauseThresholdUsd: number | null
  defaultMinAmount: number | null
  defaultMaxUsdValue: number | null
  isActive: boolean
  isVisibleToUsers: boolean
  readinessState: string
  displayOrder: number
  // Operational / chain-registry fields
  chainType: string
  rpcUrl: string | null
  rpcUrlFallback: string | null
  feeMethod: string
  fixedFeeUsd: number | null
  coingeckoId: string | null
  isPaymentEnabled: boolean
  depositAddressOverride: string | null
  usdtContractAddress: string | null
  usdtDecimals: number
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
  platformFeeUsdt: number | null  // null = inherit from parent chain
  minAmount: string | number | null  // null = inherit from parent chain
  maxUsdValue: string | number | null  // null = inherit from parent chain
  presetAmounts: number[]
  isActive: boolean
  isVisibleToUsers: boolean
  deliveryLive?: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
  chain?: { name: string; slug: string }
}

export const adminApi = {
  // Dashboard
  getStats: () =>
    apiRequest<{
      pendingKyc: number
      openDisputes: number
      pendingWithdrawals: number
      pendingInstantBuy: number
      todayRevenuePkr: string
      totalVolumePkr: string
      totalUsers: number
      newUsersToday: number
      totalTrades: number
      todayTrades: number
      unreadNotifCount: number
      recentNotifications: Array<{
        id: string
        category: AdminNotifCategory
        title: string
        body: string
        href: string | null
        isRead: boolean
        createdAt: string
      }>
      pendingGasOrders: number
      pkrGasProofsPending: number
      todayGasOrders: number
      todayGasRevenueUsdt: string
      totalGasOrders: number
      totalGasRevenueUsdt: string
      recentGasActivity: Array<{
        id: string
        orderRef: string
        chain: string
        paymentAmount: string
        paymentCoin: string | null
        paymentNetwork: string | null
        paymentTxHash: string | null
        deliveryTxHash: string | null
        gasAmountNative: string
        status: string
        createdAt: string
        updatedAt: string
        deliveredAt: string | null
      }>
    }>('/admin/dashboard/stats'),

  // Users
  getUsers: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ users: AuthUser[]; total: number }>('/admin/users' + buildQs(params)),
  getUser: (id: string) =>
    apiRequest<AuthUser>(`/admin/users/${id}`),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserProfile: (id: string) =>
    apiRequest<any>(`/admin/users/${id}/profile`),
  updateUser: (id: string, data: Partial<AuthUser>) =>
    apiRequest<AuthUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  banUser: (id: string, data: { reason: string; type?: 'permanent' | 'temporary'; until?: string; durationLabel?: string }) =>
    apiRequest<void>(`/admin/users/${id}/ban`, { method: 'POST', body: JSON.stringify(data) }),
  unbanUser: (id: string, data?: { reason?: string }) =>
    apiRequest<void>(`/admin/users/${id}/unban`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  suspendUser: (id: string, data: { reason: string; until?: string; durationLabel?: string }) =>
    apiRequest<void>(`/admin/users/${id}/suspend`, { method: 'POST', body: JSON.stringify(data) }),
  unsuspendUser: (id: string, data?: { reason?: string }) =>
    apiRequest<void>(`/admin/users/${id}/unsuspend`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  restoreAccess: (id: string, data?: { reason?: string }) =>
    apiRequest<void>(`/admin/users/${id}/restore-access`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  setUserReview: (id: string, data: { active: boolean; reason: string }) =>
    apiRequest<void>(`/admin/users/${id}/review`, { method: 'POST', body: JSON.stringify(data) }),
  resetTrustScore: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/users/${id}/reset-trust`, { method: 'POST', body: JSON.stringify(data) }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserModeration: (id: string) =>
    apiRequest<any>(`/admin/users/${id}/moderation`),
  seizeCollateral: (id: string) =>
    apiRequest<void>(`/admin/users/${id}/seize-collateral`, { method: 'POST' }),
  overrideBadge: (id: string, data: { badge: string; badgeLabel?: string; reason?: string; clearOverride?: boolean }) =>
    apiRequest<void>(`/admin/users/${id}/badge`, { method: 'POST', body: JSON.stringify(data) }),

  // Appeals (admin)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAppeals: (params?: Record<string, string | number | undefined>) =>
    apiRequest<any>('/admin/appeals' + buildQs(params)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAppeal: (id: string) =>
    apiRequest<any>(`/admin/appeals/${id}`),
  approveAppeal: (id: string, data?: { note?: string }) =>
    apiRequest<void>(`/admin/appeals/${id}/approve`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  rejectAppeal: (id: string, data: { note: string }) =>
    apiRequest<void>(`/admin/appeals/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),
  requestAppealInfo: (id: string, data: { note: string }) =>
    apiRequest<void>(`/admin/appeals/${id}/request-info`, { method: 'POST', body: JSON.stringify(data) }),

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
  // Referrals
  getReferrals: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ referrals: unknown[]; total: number }>('/admin/referrals' + buildQs(params)),
  getTopInviters: () =>
    apiRequest<unknown[]>('/admin/referrals/top-inviters'),
  getReferralChain: (userId: string) =>
    apiRequest<unknown>(`/admin/referrals/${userId}`),
  getSuspiciousReferrals: () =>
    apiRequest<unknown[]>('/admin/referrals/suspicious'),
  exportReferralsCsv: async () => {
    const token = useAuthStore.getState().accessToken
    const res = await fetch(`${API_BASE}/api/v1/admin/referrals/export`, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      credentials: 'include',
    })
    if (!res.ok) throw new Error('Export failed')
    return res.blob()
  },

  getTrades: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: Trade[]; total: number }>('/admin/trades' + buildQs(params)),
  getTrade: (id: string) =>
    apiRequest<unknown>(`/admin/trades/${id}`),
  adminConfirmPayment: (id: string) =>
    apiRequest<Trade>(`/admin/trades/${id}/confirm-payment`, { method: 'POST' }),
  adminCancelTrade: (id: string) =>
    apiRequest<Trade>(`/admin/trades/${id}/cancel`, { method: 'POST' }),

  // Disputes
  getDisputes: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ disputes: Trade[]; total: number; pagination?: unknown }>('/admin/disputes' + buildQs(params)),
  getDispute: (id: string) =>
    apiRequest<Trade>(`/admin/disputes/${id}`),
  resolveDispute: (disputeId: string, data: { winner: 'buyer' | 'seller'; resolution: string; resolutionNote?: string }) =>
    apiRequest<Trade>(`/admin/disputes/${disputeId}/resolve`, { method: 'POST', body: JSON.stringify(data) }),
  closeDispute: (id: string, data: { note: string }) =>
    apiRequest<void>(`/admin/disputes/${id}/close`, { method: 'POST', body: JSON.stringify(data) }),
  addDisputeNote: (id: string, data: { note: string }) =>
    apiRequest<void>(`/admin/disputes/${id}/note`, { method: 'POST', body: JSON.stringify(data) }),

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWithdrawal: (id: string) => apiRequest<any>(`/admin/withdrawals/${id}`),
  approveWithdrawal: (id: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/approve`, { method: 'POST' }),
  rejectWithdrawal: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),
  markWithdrawalSent: (id: string, data: { txHash: string; adminNote?: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/mark-sent`, { method: 'POST', body: JSON.stringify(data) }),
  refundWithdrawal: (id: string, reason: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/refund`, { method: 'POST', body: JSON.stringify({ reason }) }),
  holdWithdrawal: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/hold`, { method: 'POST', body: JSON.stringify(data) }),
  releaseWithdrawalHold: (id: string) =>
    apiRequest<void>(`/admin/withdrawals/${id}/release-hold`, { method: 'POST' }),
  overrideWithdrawalRisk: (id: string, data: { note: string; overrideTier?: number }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/risk-override`, { method: 'POST', body: JSON.stringify(data) }),
  markWithdrawalResolved: (id: string, data: { note: string }) =>
    apiRequest<void>(`/admin/withdrawals/${id}/mark-resolved`, { method: 'POST', body: JSON.stringify(data) }),
  getWithdrawalTiers: () =>
    apiRequest<{ tier1MaxUsd: number; tier2MaxUsd: number; tier3MaxUsd: number; autoApproveEnabled: boolean; firstWithdrawalReview: boolean; newWalletReview: boolean; velocityWindowMins: number; velocityMaxCount: number; coinPricesUsd: Record<string, number> }>('/admin/withdrawal-tiers'),
  updateWithdrawalTiers: (data: Record<string, unknown>) =>
    apiRequest<void>('/admin/withdrawal-tiers', { method: 'PUT', body: JSON.stringify(data) }),

  // Platform Revenue
  getPlatformRevenueSummary: () =>
    apiRequest<{
      allTime:   { totalTokenFees: number; totalUsdFees: number; totalSwept: number; available: number; count: number }
      today:     { totalTokenFees: number; totalUsdFees: number; count: number }
      thisWeek:  { totalTokenFees: number; totalUsdFees: number }
      thisMonth: { totalTokenFees: number; totalUsdFees: number }
      sweepable: Array<{ token: string; chain: string; collected: number; swept: number; available: number; count: number; canSweep: boolean }>
      byToken: Array<{ token: string; amount: number; usdAmount: number; count: number }>
      byChain: Array<{ chain: string; amount: number; usdAmount: number; count: number }>
      dailyChart: Array<{ date: string; tokenAmount: number; usdAmount: number; count: number }>
      treasuryAddresses: { evm: string | null; tron: string | null }
    }>('/admin/platform-revenue/summary'),
  getPlatformFeeHistory: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{
      entries: Array<{
        id: string; chain: string
        tokenSymbol: string | null; tokenAmount: string | null; usdAmount: string
        txHash: string | null; sourceKey: string | null; notes: string | null
        createdAt: string
      }>
      pagination: { page: number; limit: number; total: number; pages: number }
    }>('/admin/platform-revenue/history' + buildQs(params)),
  sweepPlatformFees: (data: { tokenSymbol: string; chain: string; amount?: number }) =>
    apiRequest<{
      txHash: string; treasuryAddress: string; hotWalletAddress: string
      tokenSymbol: string; chain: string; amount: number
      hotWalletBalanceBefore: number; remainingAvailable: number
    }>('/admin/platform-revenue/sweep', { method: 'POST', body: JSON.stringify(data) }),
  getPlatformSweepHistory: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{
      entries: Array<{
        id: string; chain: string
        tokenSymbol: string | null; tokenAmount: string | null; usdAmount: string
        txHash: string | null; fromAddress: string | null; toAddress: string | null
        notes: string | null; createdAt: string
      }>
      pagination: { page: number; limit: number; total: number; pages: number }
    }>('/admin/platform-revenue/sweep-history' + buildQs(params)),

  // Ratings
  getAdminRatings: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ ratings: unknown[]; pagination: { page: number; limit: number; total: number; pages: number } }>('/admin/ratings' + buildQs(params)),
  hideRating: (id: string) =>
    apiRequest<void>(`/admin/ratings/${id}/hide`, { method: 'POST' }),
  unhideRating: (id: string) =>
    apiRequest<void>(`/admin/ratings/${id}/unhide`, { method: 'POST' }),

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
        status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable'
        lastFetchError: string | null
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

  // Gas Wallet Activity
  getGasWalletActivity: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{
      activity: Array<{
        id: string
        entryType: string
        chain: string
        nativeAmount: string
        nativeSymbol: string
        tokenSymbol: string | null
        tokenAmount: string | null
        usdAmount: string
        txHash: string | null
        fromAddress: string | null
        toAddress: string | null
        notes: string | null
        createdAt: string
        relatedOrder: { orderRef: string; status: string; paymentCoin: string; paymentNetwork: string } | null
      }>
      pagination: { total: number; page: number; limit: number; pages: number }
    }>('/admin/gas/wallet-activity' + buildQs(params)),

  getHotWalletLiveBalances: () =>
    apiRequest<{
      balances: Array<{
        chain: string
        address: string
        friendlyAddress: string | null
        balance: number | null
        balanceUsd: number | null
        nativeSymbol: string
        tokens: Array<{ symbol: string; name: string; balanceFormatted: number; tokenAddress: string }>
        fetchedAt: string
        error: string | null
      }>
      fetchedAt: string
    }>('/admin/gas/hot-wallet-balances'),

  logManualDeposit: (body: {
    chain: string
    nativeAmount: number
    txHash?: string
    fromAddress?: string
    toAddress?: string
    notes?: string
  }) =>
    apiRequest<{ id: string }>('/admin/gas/wallet-activity/manual', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getTreasuryOverview: () =>
    apiRequest<{
      usdPkrRate: number
      platformControlledUsd: number
      categories: {
        hot: { usd: number; nativeUsd: number; usdtUsd: number }
        treasury: { usd: number }
        escrow: { usdt: number }
        custody: { usdt: number }
        revenue: { usd: number }
      }
      perChain: Array<{ chain: string; symbol: string; hotNative: number; treasuryNative: number; usd: number }>
      perToken: Array<{ symbol: string; amount: number; usd: number }>
      wallets: Array<{ chain: string; symbol: string; hotNative: number; hotUsd: number; treasuryNative: number; treasuryUsd: number; usdtUsd: number; error: string | null }>
      fetchedAt: string
    }>('/admin/treasury/overview'),
  getChainHealth: () =>
    apiRequest<{
      chains: Array<{ chain: string; name: string; nativeSymbol: string; networkLabel: string; status: 'green' | 'yellow' | 'red'; reachable: boolean; blockNumber: number | null; latencyMs: number; isStale: boolean; error: string | null; deliveryImplemented: boolean }>
      summary: { green: number; yellow: number; red: number }
      fetchedAt: string
    }>('/admin/gas/chain-health'),
  getPollerHealth: () =>
    apiRequest<{
      networks: Array<{
        network: string
        configured: boolean
        status: 'green' | 'yellow' | 'red'
        ok: boolean | null
        lastTickAt: string | null
        lastSuccessAt: string | null
        lastErrorAt: string | null
        lastError: string | null
        lastFound: number | null
        currentBlock: number | null
        syncedBlock: number | null
        ageSeconds: number | null
        successAgeSeconds: number | null
        healthy: boolean
      }>
      healthyWindowSeconds: number
    }>('/admin/gas/poller-health'),
  getSystemHealth: () =>
    apiRequest<{
      generatedAt: string
      overallHealthy: boolean
      criticalIssues: string[]
      redis: { ok: boolean; error: string | null }
      mnemonic: { configured: boolean; addresses: Record<string, string> | null }
      globallyPaused: boolean
      walletHealth: Array<{
        chain: string
        nativeSymbol: string
        balance: number | null
        balanceUsd: number | null
        isPaused: boolean
        status: 'healthy' | 'low' | 'paused' | 'unavailable'
        lastRefreshedAt: string | null
      }>
      staleRates: string[]
      queueHealth: Array<{
        name: string; waiting: number; active: number; failed: number
        lastError: string | null
        lastFailedAt: string | null
        failedJobs: Array<{ id: string; name: string; failedReason: string; attemptsMade: number; failedAt: string | null }>
      }>
      deliveryHealth: Record<string, { pending: number; failed24h: number }>
    }>('/admin/gas/system-health'),
  getQueueFailed: (name: string) =>
    apiRequest<Array<{ id: string; name: string; failedReason: string; attemptsMade: number; failedAt: string | null; data: unknown }>>(`/admin/gas/queues/${name}/failed`),
  retryQueueFailed: (name: string) =>
    apiRequest<{ retried: number; total: number }>(`/admin/gas/queues/${name}/retry-failed`, { method: 'POST' }),
  cleanQueueFailed: (name: string) =>
    apiRequest<{ removed: number }>(`/admin/gas/queues/${name}/clean-failed`, { method: 'POST' }),
  verifyWalletActivity: (id: string) =>
    apiRequest<{
      status: string
      verified: boolean | null
      message: string
      entryId: string
      chain: string
      txHash: string | null
      onChain?: { from: string | null; to: string | null; nativeValue: number; blockNumber: number | null; explorerUrl: string | null }
      expected?: { to: string | null; nativeAmount: number; tokenAmount?: number | null; tokenSymbol?: string }
    }>(`/admin/gas/wallet-activity/${id}/verify`),

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
  markGasPaymentReceived: (id: string, txHash?: string) =>
    apiRequest<{ status: string }>(`/admin/gas/orders/${id}/mark-payment`, { method: 'POST', body: JSON.stringify({ txHash }) }),
  cancelGasOrder: (id: string, reason?: string) =>
    apiRequest<{ status: string }>(`/admin/gas/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),

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
        chain: string; address: string; friendlyAddress: string | null; isActive: boolean; balance: number | null
        balanceUsd: number | null; nativeSymbol: string
        status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable'
        pauseReason: 'manual' | 'low_balance' | null
        alertThresholdUsd: number | null; pauseThresholdUsd: number | null; lastBalanceRefreshAt: string | null
      } | null
      wallets: Array<{
        chain: string; address: string; friendlyAddress: string | null; isActive: boolean; balance: number | null
        balanceUsd: number | null; nativeSymbol: string
        status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable'
        pauseReason: 'manual' | 'low_balance' | null
        alertThresholdUsd: number | null; pauseThresholdUsd: number | null; lastBalanceRefreshAt: string | null
      }>
      today:   GasFinancialKpi
      allTime: GasFinancialKpi
    }>('/admin/gas/stats'),
  getGasFinancials: (from?: string, to?: string) =>
    apiRequest<GasFinancialKpi>(
      '/admin/gas/financials' + (from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : ''),
    ),
  getHotWalletTokens: (chain: string) =>
    apiRequest<{
      chain: string
      address: string
      nativeSymbol: string
      nativeBalance: number | null
      nativeUsd: number | null
      tokens: Array<{
        symbol: string; name: string; contractAddress: string | null; logoUrl: string | null
        balance: number | null; decimals: number | null; usd: number | null; error: string | null
      }>
    }>(`/admin/gas/hot-wallet/${encodeURIComponent(chain)}/tokens`),
  getGasWallets: () =>
    apiRequest<{ wallets: Array<{ id: string; chain: string; address: string; isActive: boolean; balanceTRX: number | null; isAutoPaused: boolean }> }>('/admin/gas/wallets'),
  updateGasWalletBalance: (chain: string, balanceTRX: number) =>
    apiRequest<void>(`/admin/gas/wallets/${chain}/balance`, { method: 'POST', body: JSON.stringify({ balanceTRX }) }),
  refreshGasWalletBalance: (chain: string) =>
    apiRequest<{ chain: string; balance: number; balanceUsd: number | null; nativeSymbol: string; status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable'; pauseReason: 'manual' | 'low_balance' | null; alertThresholdUsd: number | null; pauseThresholdUsd: number | null }>(`/admin/gas/wallets/${chain}/refresh-balance`, { method: 'POST' }),
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

  // Deposit Chain Registry
  getDepositChains: () =>
    apiRequest<AdminDepositChain[]>('/admin/deposit-chains'),
  createDepositChain: (data: Omit<AdminDepositChain, 'id' | 'activeTokens' | 'createdAt' | 'updatedAt'>) =>
    apiRequest<AdminDepositChain>('/admin/deposit-chains', { method: 'POST', body: JSON.stringify(data) }),
  updateDepositChain: (slug: string, data: Partial<Pick<AdminDepositChain, 'name' | 'minConfirmations' | 'explorerBase' | 'rpcEnvVar' | 'isActive'>>) =>
    apiRequest<AdminDepositChain>(`/admin/deposit-chains/${slug}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getDepositTokens: (slug: string) =>
    apiRequest<{ tokens: AdminDepositToken[] }>(`/admin/deposit-chains/${slug}/tokens`),
  createDepositToken: (slug: string, data: { symbol: string; address?: string | null; decimals: number; coingeckoId?: string; onChainVerified?: boolean; trustWalletVerified?: boolean }) =>
    apiRequest<AdminDepositToken>(`/admin/deposit-chains/${slug}/tokens`, { method: 'POST', body: JSON.stringify(data) }),
  updateDepositToken: (slug: string, tokenId: string, data: Partial<Pick<AdminDepositToken, 'address' | 'decimals' | 'isActive' | 'coingeckoId' | 'onChainVerified' | 'trustWalletVerified'>>) =>
    apiRequest<AdminDepositToken>(`/admin/deposit-chains/${slug}/tokens/${tokenId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  lookupDepositToken: (symbol: string, chainSlug: string) =>
    apiRequest<TokenLookupResult>(`/admin/deposit-chains/lookup?symbol=${encodeURIComponent(symbol)}&chainSlug=${encodeURIComponent(chainSlug)}`),
  searchChains: (query: string) =>
    apiRequest<{ chains: ChainSearchResult[] }>(`/admin/deposit-chains/chain-search?query=${encodeURIComponent(query)}`),
  getRpcHealth: (family: string) =>
    apiRequest<RpcHealthSuggestion>(`/admin/deposit-chains/rpc-health?family=${encodeURIComponent(family)}`),
  identifyToken: (query: string) =>
    apiRequest<TokenIdentifyResult>(`/admin/deposit-chains/identify?query=${encodeURIComponent(query)}`),

  // Gas Chain Config CRUD
  lookupGasChain: (q: string) =>
    apiRequest<GasChainLookupResult>(`/admin/gas/chain-lookup?q=${encodeURIComponent(q)}`),
  lookupGasTokenByAddress: (address: string, chainSlug: string) =>
    apiRequest<TokenAddressLookupResult>(`/admin/gas/token-address-lookup?address=${encodeURIComponent(address)}&chainSlug=${encodeURIComponent(chainSlug)}`),
  getGasChains: () =>
    apiRequest<{ chains: AdminGasChain[] }>('/admin/gas/chains'),
  createGasChain: (data: Partial<AdminGasChain>) =>
    apiRequest<AdminGasChain>('/admin/gas/chains', { method: 'POST', body: JSON.stringify(data) }),
  updateGasChain: (id: string, data: Partial<AdminGasChain>) =>
    apiRequest<AdminGasChain>(`/admin/gas/chains/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGasChain: (id: string) =>
    apiRequest<void>(`/admin/gas/chains/${id}`, { method: 'DELETE' }),
  toggleGasChainVisibility: (id: string, isVisibleToUsers: boolean) =>
    apiRequest<AdminGasChain>(`/admin/gas/chains/${id}`, { method: 'PATCH', body: JSON.stringify({ isVisibleToUsers }) }),

  // Gas Token Config CRUD
  getGasTokens: (chainId?: string) =>
    apiRequest<{ tokens: AdminGasToken[] }>('/admin/gas/tokens' + (chainId ? `?chainId=${chainId}` : '')),
  createGasToken: (data: Partial<AdminGasToken>) =>
    apiRequest<AdminGasToken>('/admin/gas/tokens', { method: 'POST', body: JSON.stringify(data) }),
  updateGasToken: (id: string, data: Partial<AdminGasToken>) =>
    apiRequest<AdminGasToken>(`/admin/gas/tokens/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGasToken: (id: string) =>
    apiRequest<void>(`/admin/gas/tokens/${id}`, { method: 'DELETE' }),
  toggleGasTokenVisibility: (id: string, isVisibleToUsers: boolean) =>
    apiRequest<AdminGasToken>(`/admin/gas/tokens/${id}`, { method: 'PATCH', body: JSON.stringify({ isVisibleToUsers }) }),

  // Phase 4 — Reconciliation
  listReconciliationRuns: (page = 1, limit = 20) =>
    apiRequest<{ runs: Array<{ id: string; ranAt: string; chain: string | null; totalOrders: number; ordersChecked: number; discrepancyCount: number; status: string; notes: string | null }>; total: number; page: number; limit: number }>(`/admin/gas/reconciliation?page=${page}&limit=${limit}`),
  getReconciliationRun: (runId: string) =>
    apiRequest<{ id: string; ranAt: string; chain: string | null; totalOrders: number; ordersChecked: number; discrepancyCount: number; status: string; notes: string | null; discrepancies: Array<{ id: string; orderId: string | null; type: string; description: string; resolvedAt: string | null; resolvedBy: string | null; adminNote: string | null; createdAt: string }> }>(`/admin/gas/reconciliation/${runId}`),
  triggerReconciliation: (chain?: string) =>
    apiRequest<{ queued: boolean; message: string }>('/admin/gas/reconciliation/trigger', { method: 'POST', body: JSON.stringify({ chain }) }),
  resolveDiscrepancy: (id: string, adminNote?: string) =>
    apiRequest<void>(`/admin/gas/reconciliation/discrepancies/${id}/resolve`, { method: 'PATCH', body: JSON.stringify({ adminNote }) }),

  // Phase 5 — Flagged Orders
  listFlaggedOrders: (status?: string, page = 1, limit = 20) =>
    apiRequest<{ flagged: Array<{ id: string; orderId: string; reasons: string; riskScore: number; status: string; reviewedBy: string | null; reviewedAt: string | null; adminNote: string | null; createdAt: string; order: { orderRef: string; chain: string; status: string; toAddress: string; gasAmountUSD: number; paymentAmount: number; createdAt: string; ipAddress: string | null } }>; total: number; page: number; limit: number }>(`/admin/gas/flagged?page=${page}&limit=${limit}` + (status ? `&status=${status}` : '')),
  reviewFlaggedOrder: (id: string, status: 'reviewed_ok' | 'reviewed_blocked', adminNote?: string) =>
    apiRequest<void>(`/admin/gas/flagged/${id}/review`, { method: 'PATCH', body: JSON.stringify({ status, adminNote }) }),

  // Phase 6 — Merchants
  listMerchantAccounts: (page = 1, limit = 20) =>
    apiRequest<{ merchants: Array<{ id: string; name: string; apiKeyId: string; commissionRate: number; settlementCycle: string; payoutAddress: string | null; isActive: boolean; createdAt: string }>; total: number; page: number; limit: number }>(`/admin/gas/merchants?page=${page}&limit=${limit}`),
  getMerchantAccount: (id: string) =>
    apiRequest<{ merchant: { id: string; name: string; apiKeyId: string; commissionRate: number; settlementCycle: string; payoutAddress: string | null; isActive: boolean; createdAt: string } }>(`/admin/gas/merchants/${id}`),
  createMerchantAccount: (data: { name: string; apiKeyId: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string }) =>
    apiRequest<{ id: string }>('/admin/gas/merchants', { method: 'POST', body: JSON.stringify(data) }),
  updateMerchantAccount: (id: string, data: { name?: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string; isActive?: boolean }) =>
    apiRequest<void>(`/admin/gas/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  listMerchantSettlements: (merchantId: string, page = 1, limit = 20) =>
    apiRequest<{ settlements: Array<{ id: string; merchantId: string; periodStart: string; periodEnd: string; orderCount: number; grossRevenueUsd: number; platformFeeUsd: number; merchantShareUsd: number; status: string; payoutTxHash: string | null; paidAt: string | null; createdAt: string }>; total: number; page: number; limit: number }>(`/admin/gas/merchants/${merchantId}/settlements?page=${page}&limit=${limit}`),
  approveSettlement: (id: string, adminNote?: string) =>
    apiRequest<void>(`/admin/gas/settlements/${id}/approve`, { method: 'POST', body: JSON.stringify({ adminNote }) }),

  // Phase 7 — Advanced Analytics
  getGasBurnRates: (windowDays = 7) =>
    apiRequest<{ burnRates: Array<{ chain: string; nativePerDay: number; usdPerDay: number; windowDays: number }> }>(`/admin/gas/analytics/burn-rates?windowDays=${windowDays}`),
  getGasRunways: () =>
    apiRequest<{ runways: Array<{ chain: string; nativeSymbol: string; currentBalanceNative: number | null; burnRateNativePerDay: number; daysRemaining: number | null; status: 'healthy' | 'low' | 'critical' | 'no_data' }> }>('/admin/gas/analytics/runways'),
  getGasProfitability: (from?: string, to?: string) =>
    apiRequest<{ profitability: Array<{ chain: string; revenueUsd: number; deliveryCostUsd: number; refundCostUsd: number; netProfitUsd: number; margin: number | null }> }>('/admin/gas/analytics/profitability' + (from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : '')),
  getGasVolume: (chain?: string, windowDays = 30) =>
    apiRequest<{ series: Array<{ date: string; orders: number; revenueUsd: number }> }>(`/admin/gas/analytics/volume?windowDays=${windowDays}` + (chain ? `&chain=${chain}` : '')),

  // Phase 8 — Hot Wallet Management
  listHotWallets: (chain: string) =>
    apiRequest<{ wallets: Array<{ id: string; chain: string; address: string; friendlyAddress: string | null; hdIndex: number; weight: number; isActive: boolean; cachedBalanceNative: number | null; cachedBalanceUsd: number | null; createdAt: string }> }>(`/admin/gas/hot-wallets/${chain}`),
  addHotWallet: (chain: string) =>
    apiRequest<{ id: string; address: string; friendlyAddress: string | null; hdIndex: number }>(`/admin/gas/hot-wallets/${chain}/add`, { method: 'POST' }),
  toggleHotWallet: (id: string) =>
    apiRequest<{ id: string; isActive: boolean }>(`/admin/gas/hot-wallets/${id}/toggle`, { method: 'PATCH' }),

  // Phase 9 — Emergency
  verifyWalletDerivation: () =>
    apiRequest<{ allMatch: boolean; wallets: Array<{ chain: string; hdIndex: number; dbAddress: string; derivedAddress: string | null; match: boolean | null }> }>('/admin/gas/emergency/verify-derivation'),

  // Audit Log
  getAuditLog: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ entries: Array<{ id: string; userId: string; action: string; details: unknown; ip?: string; userAgent?: string; createdAt: string }>; total: number }>('/admin/audit-log' + buildQs(params)),

  // Admin Notifications
  getAdminNotifications: (params?: { category?: string; unreadOnly?: boolean; page?: number; limit?: number }) =>
    apiRequest<{
      notifications: AdminNotif[]
      unreadCount: number
      pagination: { page: number; limit: number; total: number; pages: number }
    }>('/admin/notifications' + buildQs(params as Record<string, string | number | undefined>)),
  getAdminUnreadCount: (category?: string) =>
    apiRequest<{ count: number }>('/admin/notifications/unread-count' + (category ? `?category=${category}` : '')),
  getAdminNavCounts: () =>
    apiRequest<{
      kyc: number
      appeals: number
      disputes: number
      ctmDisputes: number
      withdrawals: number
      gasRequests: number
    }>('/admin/nav-counts'),
  markAdminNotifRead: (id: string) =>
    apiRequest<void>(`/admin/notifications/${id}/read`, { method: 'PATCH' }),
  markAllAdminNotifsRead: (category?: string) =>
    apiRequest<void>('/admin/notifications/read-all' + (category ? `?category=${category}` : ''), { method: 'PATCH' }),
  deleteOldAdminNotifs: () =>
    apiRequest<{ deleted: number }>('/admin/notifications/old', { method: 'DELETE' }),
}

// ─── Community Token Market ───────────────────────────────────────────────────

export const ctmApi = {
  // Tokens
  getTokens: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ tokens: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/tokens' + buildQs(params)),
  getToken: (slug: string) => apiRequest<unknown>(`/ctm/tokens/${slug}`),
  getTokenMarketInsight: (tokenId: string) => apiRequest<{
    avg12h: number | null
    buyAvg12h: number | null
    sellAvg12h: number | null
    previous12hAvg: number | null
    changePercent: number | null
    lastTradePrice: number | null
    lastTradedAt: string | null
    dataSource: 'completed_trades' | 'active_listings' | 'none'
    sampleSize: number
    lowData: boolean
  }>(`/ctm/tokens/${tokenId}/market-insight`),
  suggestToken: (data: object) => apiRequest<unknown>('/ctm/tokens/suggest', { method: 'POST', body: JSON.stringify(data) }),
  adminListTokens: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ tokens: unknown[]; total: number; page: number; limit: number; totalPages: number }>(
      '/ctm/tokens' + buildQs({ adminView: 'true', ...params })
    ),
  adminGetTokenQueue: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ requests: unknown[]; total: number; page: number; limit: number }>('/ctm/tokens/admin/queue' + buildQs(params)),
  adminCreateToken: (data: object) => apiRequest<unknown>('/ctm/tokens/admin', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdateToken: (id: string, data: object) => apiRequest<unknown>(`/ctm/tokens/admin/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminDelistToken: (id: string) => apiRequest<void>(`/ctm/tokens/admin/${id}/delist`, { method: 'POST' }),
  adminApproveTokenRequest: (id: string, data: object) => apiRequest<unknown>(`/ctm/tokens/admin/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
  adminRejectTokenRequest: (id: string, data: object) => apiRequest<void>(`/ctm/tokens/admin/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),

  // Stats & feed
  getStats: () =>
    apiRequest<{ activeListings: number; todayTrades: number; totalTrades: number; totalTokens: number }>('/ctm/stats'),
  getRecentTrades: () =>
    apiRequest<RecentTrade[]>('/ctm/recent-trades'),

  // Listings
  getListings: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ listings: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/listings' + buildQs(params)),
  getMyListings: () => apiRequest<{ listings: unknown[]; total: number }>('/ctm/listings/me'),
  getListing: (id: string) => apiRequest<unknown>(`/ctm/listings/${id}`),
  createListing: (data: object) => apiRequest<unknown>('/ctm/listings', { method: 'POST', body: JSON.stringify(data) }),
  updateListing: (id: string, data: object) => apiRequest<unknown>(`/ctm/listings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  pauseListing: (id: string) => apiRequest<unknown>(`/ctm/listings/${id}/pause`, { method: 'POST' }),
  activateListing: (id: string) => apiRequest<unknown>(`/ctm/listings/${id}/activate`, { method: 'POST' }),
  deleteListing: (id: string) => apiRequest<void>(`/ctm/listings/${id}`, { method: 'DELETE' }),
  startListingTrade: (id: string, data: { paymentMethod?: string; paymentMethods?: string[]; buyerSettlementId?: string; buyerPaymentMethodId?: string; tokenAmount: number }) =>
    apiRequest<{ tradeRef: string }>(`/ctm/listings/${id}/trade`, { method: 'POST', body: JSON.stringify(data) }),

  // Listing bids
  placeListingBid: (listingId: string, data: { pricePerUnit: number; tokenAmount: number }) =>
    apiRequest<unknown>(`/ctm/listings/${listingId}/bids`, { method: 'POST', body: JSON.stringify(data) }),
  confirmBidDetails: (bidId: string, data: { paymentMethod?: string; paymentMethods?: string[]; buyerSettlementId?: string; buyerPaymentMethodId?: string; message?: string }) =>
    apiRequest<{ tradeRef: string }>(`/ctm/bids/${bidId}/confirm-details`, { method: 'POST', body: JSON.stringify(data) }),
  getListingBids: (listingId: string) => apiRequest<unknown[]>(`/ctm/listings/${listingId}/bids`),
  getMyListingBids: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ bids: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/bids/me' + buildQs(params)),
  acceptListingBid: (bidId: string) => apiRequest<{ tradeRef?: string; status?: string; bidId?: string }>(`/ctm/bids/${bidId}/accept`, { method: 'POST' }),
  rejectListingBid: (bidId: string) => apiRequest<void>(`/ctm/bids/${bidId}/reject`, { method: 'POST' }),
  cancelListingBid: (bidId: string) => apiRequest<void>(`/ctm/bids/${bidId}`, { method: 'DELETE' }),
  getListingActivity: (id: string) => apiRequest<unknown>(`/ctm/listings/${id}/activity`),

  // Requests (bid/RFQ mode)
  getRequests: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ requests: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/requests' + buildQs(params)),
  getMyRequests: () => apiRequest<{ requests: unknown[]; bids: unknown[] }>('/ctm/requests/me'),
  getRequest: (id: string) => apiRequest<unknown>(`/ctm/requests/${id}`),
  createRequest: (data: object) => apiRequest<unknown>('/ctm/requests', { method: 'POST', body: JSON.stringify(data) }),
  cancelRequest: (id: string) => apiRequest<void>(`/ctm/requests/${id}`, { method: 'DELETE' }),
  submitBid: (requestId: string, data: object) => apiRequest<unknown>(`/ctm/requests/${requestId}/bids`, { method: 'POST', body: JSON.stringify(data) }),
  withdrawBid: (requestId: string, bidId: string) => apiRequest<void>(`/ctm/requests/${requestId}/bids/${bidId}`, { method: 'DELETE' }),
  acceptBid: (requestId: string, bidId: string) => apiRequest<unknown>(`/ctm/requests/${requestId}/accept/${bidId}`, { method: 'POST' }),

  // Trades
  getMyTrades: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/trades' + buildQs(params)),
  getTrade: (ref: string) => apiRequest<unknown>(`/ctm/trades/${ref}`),
  uploadPaymentProof: (ref: string, formData: FormData) =>
    apiRequest<{ fileUrl: string }>(`/ctm/trades/${ref}/payment-proof`, { method: 'POST', body: formData }),
  confirmPayment: (ref: string) => apiRequest<void>(`/ctm/trades/${ref}/confirm-payment`, { method: 'POST' }),
  markTransferring: (ref: string) => apiRequest<void>(`/ctm/trades/${ref}/seller-transferring`, { method: 'POST' }),
  uploadTokenProof: (ref: string, data: object | FormData) =>
    apiRequest<{ fileUrl?: string }>(`/ctm/trades/${ref}/token-proof`, { method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data) }),
  confirmReceipt: (ref: string) => apiRequest<void>(`/ctm/trades/${ref}/confirm-receipt`, { method: 'POST' }),
  openDispute: (ref: string, data: object) => apiRequest<void>(`/ctm/trades/${ref}/dispute`, { method: 'POST', body: JSON.stringify(data) }),
  cancelTrade: (ref: string, data: object) => apiRequest<void>(`/ctm/trades/${ref}/cancel`, { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (ref: string, data: object) => apiRequest<unknown>(`/ctm/trades/${ref}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  getMessages: (ref: string) => apiRequest<unknown[]>(`/ctm/trades/${ref}/messages`),
  rateTrade: (ref: string, data: object) => apiRequest<unknown>(`/ctm/trades/${ref}/rate`, { method: 'POST', body: JSON.stringify(data) }),
  selectTradePaymentAccount: (ref: string, accountIndex: number) =>
    apiRequest<{ selectedIdx: number; selectedAccount: Record<string, string> }>(`/ctm/trades/${ref}/select-payment-account`, { method: 'POST', body: JSON.stringify({ accountIndex }) }),

  // Merchant profile
  getMyCtmProfile: () => apiRequest<unknown>('/ctm/merchants/me'),
  registerCtmMerchant: () => apiRequest<unknown>('/ctm/merchants/register', { method: 'POST' }),
  updateSettlementInstructions: (data: object) => apiRequest<unknown>('/ctm/merchants/me/settlement', { method: 'PATCH', body: JSON.stringify(data) }),
  getPublicMerchant: (userId: string) => apiRequest<unknown>(`/ctm/merchants/${userId}/public`),

  // Admin
  adminGetTrades: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/trades/admin/all' + buildQs(params)),
  adminResolveDispute: (ref: string, data: object) => apiRequest<void>(`/ctm/trades/admin/${ref}/resolve-dispute`, { method: 'POST', body: JSON.stringify(data) }),
  adminAddDisputeMessage: (ref: string, message: string) => apiRequest<unknown>(`/ctm/trades/admin/${ref}/dispute-message`, { method: 'POST', body: JSON.stringify({ message }) }),
  adminConfirmPayment: (ref: string) => apiRequest<void>(`/ctm/trades/admin/${ref}/confirm-payment`, { method: 'POST' }),
  adminForceRelease: (ref: string) => apiRequest<void>(`/ctm/trades/admin/${ref}/release`, { method: 'POST' }),
  adminGetMerchantQueue: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ merchants: unknown[]; total: number; page: number; limit: number }>('/ctm/merchants/admin/queue' + buildQs(params)),
  adminApproveMerchant: (id: string, data?: object) => apiRequest<unknown>(`/ctm/merchants/admin/${id}/approve`, { method: 'POST', body: data ? JSON.stringify(data) : undefined }),
  adminSuspendMerchant: (id: string, data: object) => apiRequest<unknown>(`/ctm/merchants/admin/${id}/suspend`, { method: 'POST', body: JSON.stringify(data) }),
  adminChangeMerchantTier: (id: string, tier: string) => apiRequest<unknown>(`/ctm/merchants/admin/${id}/tier`, { method: 'PATCH', body: JSON.stringify({ tier }) }),

  // Admin proofs
  adminGetProofs: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ proofs: unknown[]; total: number; page: number; limit: number }>('/ctm/trades/admin/proofs' + buildQs(params)),
  adminReviewProof: (id: string, data: object) => apiRequest<void>(`/ctm/trades/admin/proofs/${id}/review`, { method: 'POST', body: JSON.stringify(data) }),

  // Admin stats + escrow
  adminGetCtmStats: () => apiRequest<unknown>('/ctm/admin/stats'),
  adminGetEscrowQueue: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: unknown[]; total: number }>('/ctm/admin/escrow' + buildQs(params)),

  // Escrow info for ON_CHAIN trades
  getEscrowInfo: (ref: string) => apiRequest<unknown>(`/ctm/trades/${ref}/escrow-info`),
}

// ─── Logo Registry ────────────────────────────────────────────────────────────

export interface LogoRegistryEntry {
  id:        string
  type:      string
  slug:      string
  logoUrl:   string
  createdAt: string
  updatedAt: string
}

export const logoApi = {
  /** Public: get all logos merged from GasChainConfig, GasTokenConfig, CtmToken, LogoRegistry */
  getAll: () => apiRequest<{
    chain:           Record<string, string>
    token:           Record<string, string>
    payment_method:  Record<string, string>
    bank:            Record<string, string>
    wallet_provider: Record<string, string>
  }>('/logos'),

  /** Admin: list all LogoRegistry rows */
  adminList: () => apiRequest<LogoRegistryEntry[]>('/admin/logos'),

  /** Admin: upsert a logo registry entry */
  adminUpsert: (body: { type: string; slug: string; logoUrl: string }) =>
    apiRequest<LogoRegistryEntry>('/admin/logos', {
      method: 'POST',
      body:   JSON.stringify(body),
    }),

  /** Admin: delete a logo registry entry */
  adminDelete: (id: string) =>
    apiRequest<void>(`/admin/logos/${id}`, { method: 'DELETE' }),
}

// ─── Appeals (user-facing, appeal-token authenticated) ─────────────────────────
// Banned/suspended users have no session — they hold a short-lived appeal token
// (from the restricted login response). These calls authenticate with it directly.

export interface AppealMe {
  status: 'active' | 'suspended' | 'temporarily_banned' | 'permanently_banned' | 'under_review'
  reason: string | null
  until: string | null
  canAppeal: boolean
  appeals: Array<{
    id: string
    status: 'pending' | 'approved' | 'rejected' | 'more_info_requested'
    subjectStatus: string
    explanation: string
    evidenceUrls: string[]
    decisionNote: string | null
    reviewedAt: string | null
    createdAt: string
  }>
}

async function appealRequest<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
    Authorization: 'Bearer ' + token,
  }
  if (options?.body !== undefined && options.body !== null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  if (UNSAFE_METHODS.has(method)) {
    const csrf = await fetchCsrfToken()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  const res = await fetch(`${API_BASE}/api/v1${path}`, { ...options, method, headers, credentials: 'include' })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(
      (raw as { error?: string }).error ?? 'UNKNOWN_ERROR',
      (raw as { message?: string }).message ?? 'An error occurred',
      res.status,
      (raw as { requestId?: string }).requestId,
    )
  }
  return unwrapEnvelope<T>(raw)
}

export const appealApi = {
  me: (token: string) => appealRequest<AppealMe>('/appeals/me', token),
  submit: (token: string, data: { explanation: string; evidenceUrls?: string[] }) =>
    appealRequest<{ id: string; status: string; createdAt: string }>('/appeals', token, { method: 'POST', body: JSON.stringify(data) }),
  presignEvidence: (token: string, mimeType: string) =>
    appealRequest<{ url: string; fields: Record<string, string>; publicUrl: string }>('/appeals/evidence/presign', token, { method: 'POST', body: JSON.stringify({ mimeType }) }),
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
