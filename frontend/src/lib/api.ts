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
export const API_BASE = resolveApiBase()

import { useAuthStore } from '../store/auth.store'
import type { AuthUser } from '../store/auth.store'
import { promptForTotp } from './totpPrompt'
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

// ─── Resilient transport ─────────────────────────────────────────────────────
//
// fetch() rejects with a bare TypeError ("Failed to fetch") whenever a request
// never completes at the transport layer — socket reset, radio asleep, DNS/TLS
// failure. It is NOT an HTTP error: there is no status and no body. Mobile users
// (installed PWA + Telegram Mini App) hit this constantly, for one dominant
// reason:
//
//   The frontend (Vercel) and the API (Railway) are separate origins, so the
//   browser holds long-lived connections open to the API. Mobile radios sleep and
//   carrier NATs (Pakistan is overwhelmingly CGNAT) silently reap idle TCP
//   connections without telling the client. When the app is foregrounded the
//   browser reuses a socket it believes is alive but which is already dead, and
//   the first request fails instantly. That is precisely why tapping "Try again"
//   always fixed it — the retry opens a fresh socket.
//
// So we retry transport failures here, in the one place every call passes
// through, instead of letting a dead socket become a full-page error.

const NETWORK_MESSAGE = 'Can’t reach RupChain. Check your connection and try again.'

// A stalled request is expensive, so the first attempt gets a tighter deadline
// and later ones get the headroom a cold Railway container + slow 4G needs.
const READ_TIMEOUTS_MS = [15_000, 20_000, 20_000]
const WRITE_TIMEOUT_MS = 20_000
// A file upload is not a stalled request — it is a slow one. CTM payment/token
// proofs post a FormData image (up to the backend's 10MB multipart limit), and on
// the 4G links our users are actually on that takes far longer than a write
// deadline meant for a JSON POST. Capping those at 20s aborted people mid-upload
// and surfaced as the very "can't reach" error this file exists to kill.
const UPLOAD_TIMEOUT_MS = 90_000
const MAX_ATTEMPTS = 3
// Fast transport failures are cheap to replay; timeouts are not. Stop retrying
// after this many attempts have actually run out the clock.
const MAX_TIMED_OUT_ATTEMPTS = 2

function networkError(): ApiError {
  return new ApiError('NETWORK_ERROR', NETWORK_MESSAGE, 0)
}

/** True when a request never reached the server (no response at all). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'NETWORK_ERROR'
}

// Replaying a request is only safe when a second delivery cannot produce a
// second side-effect. GET/HEAD are idempotent by definition, and an unsafe
// method qualifies only when it carries an idempotency key the backend de-dupes
// on. Everything else (create trade, place bid, release crypto) is delivered
// exactly once — a dropped connection there surfaces to the user rather than
// risking a duplicate.
function isReplayable(method: string, headers: Record<string, string>, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return true
  if (headers['X-Idempotency-Key']) return true
  // Both re-auth endpoints are pure lookups: /auth/refresh validates the refresh
  // cookie and only slides the session expiry (it does NOT rotate the token), and
  // /miniapp/auth re-validates HMAC-signed launch data. Replaying either is a
  // no-op, and NOT retrying them is what turns a dead socket into a spurious
  // logout — the worst failure of all.
  return path === '/auth/refresh' || path === '/miniapp/auth'
}

/** Park until the device reports a network again — capped, so we never hang. */
async function waitForOnline(maxWaitMs = 8_000): Promise<void> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (navigator.onLine) return
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('online', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, maxWaitMs)
    window.addEventListener('online', done)
  })
}

const jitteredBackoff = (attempt: number) => 400 * attempt + Math.random() * 250

/**
 * fetch() + per-attempt timeout + automatic replay of transport failures.
 *
 * Resolves with the Response for ANY HTTP status — a 4xx/5xx is an answer, not a
 * failure, and callers handle it. Throws only NETWORK_ERROR, and only once the
 * request genuinely could not be delivered.
 */
async function resilientFetch(
  url: string,
  init: RequestInit,
  method: string,
  headers: Record<string, string>,
  path: string,
): Promise<Response> {
  const isWrite = UNSAFE_METHODS.has(method)
  const isUpload = typeof FormData !== 'undefined' && init.body instanceof FormData
  const attempts = isReplayable(method, headers, path) ? MAX_ATTEMPTS : 1
  const external = init.signal ?? undefined

  const timeoutFor = (attempt: number): number => {
    if (isUpload) return UPLOAD_TIMEOUT_MS
    if (isWrite) return WRITE_TIMEOUT_MS
    return READ_TIMEOUTS_MS[attempt - 1] ?? WRITE_TIMEOUT_MS
  }

  let timedOutAttempts = 0
  let lastErr: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutFor(attempt))

    // A caller-supplied signal must still be able to cancel us mid-flight.
    const onExternalAbort = () => controller.abort()
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      return await fetch(url, {
        ...init,
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
      })
    } catch (err) {
      lastErr = err
      // A caller cancelled deliberately — honour it, never retry.
      if (external?.aborted) throw err

      if (controller.signal.aborted) timedOutAttempts += 1
      if (attempt === attempts) break
      if (timedOutAttempts >= MAX_TIMED_OUT_ATTEMPTS) break

      await waitForOnline()
      await new Promise((r) => setTimeout(r, jitteredBackoff(attempt)))
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  // eslint-disable-next-line no-console
  console.warn('[RupChain] request failed after retries:', method, path, lastErr)
  throw networkError()
}

/** resilientFetch + envelope unwrap + ApiError on a non-2xx. Used by every retry path. */
async function sendAndParse<T>(
  url: string,
  init: RequestInit,
  method: string,
  headers: Record<string, string>,
  path: string,
): Promise<T> {
  const res = await resilientFetch(url, init, method, headers, path)
  let data: unknown = {}
  try { data = await res.json() } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error ?? 'UNKNOWN_ERROR',
      (data as { message?: string }).message ?? 'An error occurred',
      res.status,
      (data as { requestId?: string }).requestId,
    )
  }
  return unwrapEnvelope<T>(data)
}

let isRefreshing = false
let refreshQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = []

// Cached CSRF fetch so concurrent requests don't all fire at once
let csrfFetchPromise: Promise<string> | null = null

async function fetchCsrfToken(): Promise<string> {
  if (!csrfFetchPromise) {
    csrfFetchPromise = (async () => {
      try {
        const res = await resilientFetch(
          `${API_BASE}/api/v1/auth/csrf`, {}, 'GET', {}, '/auth/csrf',
        )
        if (res.ok) {
          const raw = await res.json() as { data?: { token: string }; token?: string }
          return raw.data?.token ?? (raw as { token?: string }).token ?? ''
        }
      } catch { /* ignore — CSRF is re-fetched on demand */ }
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
  const data = await sendAndParse<{ accessToken: string }>(
    `${API_BASE}/api/v1/auth/refresh`, {}, 'POST', {}, '/auth/refresh',
  )
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

  // Transport failures are replayed by resilientFetch (initData is HMAC-validated
  // server-side, so a replay is a no-op). A 5xx is a real answer, not a transport
  // failure, so it still needs its own retry: the Mini App is the very first
  // request a user makes, often against a cold Railway container.
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await resilientFetch(
        `${API_BASE}/api/v1/miniapp/auth`,
        { body: JSON.stringify({ initData }) },
        'POST',
        { 'Content-Type': 'application/json' },
        '/miniapp/auth',
      )
    } catch (networkErr) {
      // Keep the "NETWORK:" prefix the Mini App bridge surfaces for diagnostics,
      // but carry it as a typed NETWORK_ERROR so callers (and the 401 re-auth
      // path) can tell "no connection" apart from "session is genuinely dead"
      // and never sign the user out over a dropped socket.
      throw new ApiError(
        'NETWORK_ERROR',
        `NETWORK: ${networkErr instanceof Error ? networkErr.message : 'request failed'}`,
        0,
      )
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

  const res = await resilientFetch(url, options ?? {}, method, headers, path)

  // Handle 401 with re-auth + retry
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

    let newToken: string

    if (!isRefreshing) {
      isRefreshing = true
      try {
        newToken = await reauth()
      } catch (err) {
        isRefreshing = false
        // Hand the failure to everyone waiting behind us. The old code cleared the
        // queue WITHOUT settling it, so every queued caller hung forever.
        const waiting = refreshQueue
        refreshQueue = []
        waiting.forEach((q) => q.reject(err))

        // A dropped connection is NOT an expired session. Signing a user out
        // because their radio slept is the worst possible outcome, so surface it
        // as a network error and leave the session untouched.
        if (isNetworkError(err)) throw err

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

      useAuthStore.getState().setAccessToken(newToken)
      isRefreshing = false
      const waiting = refreshQueue
      refreshQueue = []
      waiting.forEach((q) => q.resolve(newToken))
    } else {
      // A re-auth is already in flight — wait for it instead of starting a second.
      newToken = await new Promise<string>((resolve, reject) => {
        refreshQueue.push({ resolve, reject })
      })
    }

    // Replay the original request with the fresh token. A failure here is a real
    // answer from the server, not an auth failure — it must never trigger a logout,
    // which is exactly what the old catch-all around this retry did.
    headers['Authorization'] = 'Bearer ' + newToken
    return sendAndParse<T>(url, options ?? {}, method, headers, path)
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
      const code = (data as { error?: string }).error
      const message = (data as { message?: string }).message
      // Two very different things return 429:
      //  • the global rate limiter (code TOO_MANY_REQUESTS) — no actionable detail,
      //    so we show a friendly retry hint with the Retry-After countdown.
      //  • application limits (concurrent-trade cap → TOO_MANY_OPEN_TRADES /
      //    COUNTERPARTY_TOO_MANY_TRADES, gas order cap → RATE_LIMITED, etc.) — these
      //    carry a specific, actionable message ("You can have 3 active trades at a
      //    time. Finish a current trade first."). Surface it verbatim instead of
      //    masking it behind the generic text.
      if (message && code && code !== 'TOO_MANY_REQUESTS') {
        throw new ApiError(code, message, 429, (data as { requestId?: string }).requestId)
      }
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

    // TOTP step-up — the backend demands a 2FA code for this action. A single
    // shared prompt (see lib/totpPrompt) serves all concurrent callers, so a
    // "save" that fans out into several parallel requests asks ONCE, not per
    // request. We do NOT cache/re-send the code: it's single-use (the backend
    // replay-guards it), and a verified code opens a multi-minute backend "grace
    // window" during which further admin requests need no code at all — so the
    // next save simply sails through code-less. If a parallel sibling used the
    // same code first (TOTP_REPLAY), the grace window is already open, so we just
    // retry this request without a code. Flows with their own inline TOTP field
    // (wallet withdraw / trusted address) pre-send the header and never reach here.
    if (res.status === 403 && (data as { error?: string }).error === 'TOTP_REQUIRED' && typeof window !== 'undefined') {
      const entered = await promptForTotp()
      const trimmed = entered?.trim()
      if (trimmed && /^\d{6}$/.test(trimmed)) {
        const runRetry = async (withCode: boolean) => {
          const retryHeaders = { ...headers }
          if (withCode) retryHeaders['X-TOTP-Code'] = trimmed
          else delete retryHeaders['X-TOTP-Code']
          const retryRes = await resilientFetch(url, options ?? {}, method, retryHeaders, path)
          let retryData: unknown = {}
          try { retryData = await retryRes.json() } catch { /* empty body */ }
          return { ok: retryRes.ok, status: retryRes.status, data: retryData }
        }

        let r = await runRetry(true)
        // A sibling request in the same burst already consumed this code and
        // opened the grace window — retry once more with no code (grace covers us).
        if (!r.ok && (r.data as { error?: string }).error === 'TOTP_REPLAY') {
          r = await runRetry(false)
        }
        if (!r.ok) {
          throw new ApiError(
            (r.data as { error?: string }).error ?? 'UNKNOWN_ERROR',
            (r.data as { message?: string }).message ?? 'An error occurred',
            r.status,
          )
        }
        return unwrapEnvelope<T>(r.data)
      }
    }

    // Stale CSRF token — refresh and retry the original request once
    if (res.status === 403 && (data as { error?: string }).error === 'INVALID_CSRF_TOKEN') {
      invalidateCsrfToken()
      const freshCsrf = await fetchCsrfToken()
      if (freshCsrf) {
        useAuthStore.getState().setCsrfToken(freshCsrf)
        headers['X-CSRF-Token'] = freshCsrf
        return sendAndParse<T>(url, options ?? {}, method, headers, path)
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

// Fetch a binary asset (image/video) through our own API with the admin Bearer
// token attached. Used for KYC documents, which are stored as authenticated
// Cloudinary assets: streaming them via our origin sidesteps CSP / cross-site
// cookie issues that break a direct <img src> to res.cloudinary.com. Returns an
// object URL the caller must revoke when done. Retries once through reauth on 401.
export async function apiRequestBlob(path: string): Promise<string> {
  const url = `${API_BASE}/api/v1${path}`
  const doFetch = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = 'Bearer ' + token
    return resilientFetch(url, {}, 'GET', headers, path)
  }

  let res = await doFetch(useAuthStore.getState().accessToken)
  if (res.status === 401) {
    try {
      const newToken = await reauth()
      useAuthStore.getState().setAccessToken(newToken)
      res = await doFetch(newToken)
    } catch (err) {
      // Same rule as apiRequest: a dead connection is not a dead session.
      if (isNetworkError(err)) throw err
      throw new ApiError('UNAUTHORIZED', 'Session expired. Please log in again.', 401)
    }
  }
  if (!res.ok) {
    throw new ApiError('ASSET_ERROR', `Failed to load asset (${res.status})`, res.status)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
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

export interface TrustedDevice {
  id: string
  label: string
  ip: string | null
  lastIp: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}

export type AdminNotifCategory = 'KYC' | 'TRADE' | 'GAS' | 'DISPUTE' | 'CTM' | 'SYSTEM' | 'DEPOSIT' | 'WITHDRAWAL'

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
  status: 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed' | 'dispute_resolved' | 'expired'
  paymentMethod: string
  paymentProofUrl?: string
  buyerWalletAddress?: string
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  sellerTxHash?: string
  txHash?: string
  takerFirst?: boolean
  buyerRated?: boolean
  sellerRated?: boolean
  expiresAt: string
  /** Set when the buyer uploads payment proof (anchor for the dispute-unlock delay). */
  paymentUploadedAt?: string | null
  /** Set when the seller confirms payment received. */
  paymentConfirmedAt?: string | null
  /** Set when the trade completes (crypto_released) — anchor for the rating window. */
  releasedAt?: string | null
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
  networks?: string[]
  priceType: 'fixed' | 'float'
  price: string
  floatOffset: string
  totalAmount: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  /** Payment-method IDs resolved to human labels (e.g. "JazzCash"). Present on
      list + detail responses; falls back to the raw id if a method was deleted. */
  resolvedPaymentMethods?: { id: string; type: string; label: string }[]
  tokenDeliveryTypes?: string[]
  settlementMethod?: string
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
  networks?: string[]
  priceType: 'fixed' | 'float'
  price: number
  floatOffset?: number
  totalAmount?: number
  minOrder: number
  maxOrder: number
  paymentMethods: string[]
  tokenDeliveryTypes?: string[]
  settlementMethod?: string
  settlementDestinations?: Array<{ method: string; network?: string | null; address: string }>
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
  /** True when the maker-bond feature is ON and this maker can't cover the bond
   *  for even their min order — the trade would be rejected. Undefined when off. */
  makerBondInsufficient?: boolean
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
  verify2fa: (data: { preAuthToken: string; code: string; trustDevice?: boolean }) =>
    apiRequest<{ accessToken: string; user: AuthUser }>('/auth/2fa/verify', { method: 'POST', body: JSON.stringify(data) }),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiRequest<void>('/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
  getSessions: () =>
    apiRequest<Session[]>('/auth/sessions'),
  revokeSession: (id: string) =>
    apiRequest<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  getTrustedDevices: () =>
    apiRequest<TrustedDevice[]>('/auth/devices'),
  forgetTrustedDevice: (id: string) =>
    apiRequest<void>(`/auth/devices/${id}`, { method: 'DELETE' }),
  forgetAllTrustedDevices: () =>
    apiRequest<void>('/auth/devices', { method: 'DELETE' }),
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
  unlinkTelegram: (password: string) =>
    apiRequest<AuthUser>('/account/telegram/unlink', {
      method: 'POST',
      body: JSON.stringify({ password }),
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
  getUsdtInsight: () =>
    apiRequest<{ avg: number | null; buyAvg: number | null; sellAvg: number | null; sampleSize: number; lowData: boolean; dataSource: string; marginPct: number }>('/marketplace/rates/usdt-insight'),
  getUsdtReferenceRate: () =>
    apiRequest<{ rate: number | null; source: 'recent_trades' | 'active_listings' | 'fx_spot' | 'none'; sampleSize: number }>('/marketplace/rates/usdt-reference'),
  getUsdtPriceHistory: (range: CtmPriceRange) =>
    apiRequest<UsdtPriceHistory>('/marketplace/rates/usdt-history' + buildQs({ range })),
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
  getSavedAddresses: (includeHidden = false) =>
    apiRequest<SavedDeliveryAddress[]>(`/wallet/saved-addresses${includeHidden ? '?includeHidden=1' : ''}`),
  addSavedAddress: (data: { coin: string; network: string; address: string; label: string }) =>
    apiRequest<SavedDeliveryAddress>('/wallet/saved-addresses', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateSavedAddress: (id: string, data: { label?: string; address?: string }) =>
    apiRequest<SavedDeliveryAddress>(`/wallet/saved-addresses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  setSavedAddressHidden: (id: string, hidden: boolean) =>
    apiRequest<SavedDeliveryAddress>(`/wallet/saved-addresses/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  deleteSavedAddress: (id: string) =>
    apiRequest<void>(`/wallet/saved-addresses/${id}`, { method: 'DELETE' }),
}

export const tradesApi = {
  createTrade: (data: { adId: string; amount: number | string; paymentMethod: string; buyerDeliveryMethod?: string; buyerDeliveryAddress?: string; network?: string; buyerPayFromMethodId?: string }) =>
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
  // Seller: confirm payment received (transitions payment_uploaded → payment_confirmed).
  // confirmedReceipt is the verified-receipt acknowledgment ("money actually arrived,
  // not just a screenshot") required by non-custodial mode.
  confirmPayment: (id: string, confirmedReceipt = true) =>
    apiRequest<Trade>(`/trades/${id}/confirm-payment`, { method: 'POST', body: JSON.stringify({ confirmedReceipt }) }),
  // Seller: "payment not received" — bounce the buyer's proof back to unpaid with a reason.
  // reason ∈ fake_screenshot | wrong_amount | wrong_account | not_received | other
  rejectPayment: (id: string, data: { reason: string; detail: string }) =>
    apiRequest<{ outcome: 'bounced' | 'disputed'; rejectionCount: number; remaining?: number }>(`/trades/${id}/reject-payment`, { method: 'POST', body: JSON.stringify(data) }),
  // Seller: mark crypto sent with txHash (transitions payment_confirmed → crypto_sent)
  markCryptoSent: (id: string, txHash: string, screenshotUrl?: string) =>
    apiRequest<Trade>(`/trades/${id}/crypto-sent`, { method: 'POST', body: JSON.stringify({ txHash, ...(screenshotUrl ? { screenshotUrl } : {}) }) }),
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
    apiRequest<{ messages: Array<{ id: string; senderId: string; message: string; isSystem?: boolean; createdAt: string }> }>(`/trades/${id}/messages`),
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
  bidder?: { id: string; username: string; fullName?: string | null }
  trade?: { id?: string; orderRef: string; status: string } | null
  ad?: Ad & { user: { id: string; username: string } }
}

export interface AdActivity {
  myBid?: { id: string; status: string; expiresAt: string; pricePerUnit: string; usdtAmount: string; fiatAmount: string } | null
  bids: { pendingCount: number; totalCount?: number; minPrice: string | null; maxPrice: string | null; items?: AdBid[]; publicItems?: Array<{ id: string; pricePerUnit: string; usdtAmount: string; fiatAmount: string; status: string; createdAt: string; bidder?: { username: string; fullName?: string | null } | null }> }
  trades: { activeCount: number; completedCount: number; lastTradePrice: string | null; lastTradeAt: string | null; items?: Array<{ id: string; orderRef: string; status: string; amount: string; price: string; fiatAmount: string; createdAt: string; buyer: { username: string; fullName?: string | null }; seller: { username: string; fullName?: string | null } }>; publicItems?: Array<{ orderRef: string; status: string; amount: string; price: string; fiatAmount: string; createdAt: string; buyer: { username: string }; seller: { username: string } }> }
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
  hidden?: boolean
  createdAt: string
}

export const userPaymentMethodsApi = {
  getAll: (includeHidden = false) =>
    apiRequest<UserPaymentMethod[]>(`/users/me/payment-methods${includeHidden ? '?includeHidden=1' : ''}`),
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
  edit: (id: string, data: { accountName?: string; mobileNumber?: string; ibanNumber?: string; accountNumber?: string }) =>
    apiRequest<UserPaymentMethod>(`/users/me/payment-methods/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  setHidden: (id: string, hidden: boolean) =>
    apiRequest<UserPaymentMethod>(`/users/me/payment-methods/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  remove: (id: string) =>
    apiRequest<void>(`/users/me/payment-methods/${id}`, { method: 'DELETE' }),
}

export interface SocialLinkItem {
  id: string
  platform: string
  url: string
  verified: boolean
  hidden: boolean
}

export const socialLinksApi = {
  get: () =>
    apiRequest<{ links: SocialLinkItem[]; public: boolean }>('/users/me/social-links'),
  add: (platform: string, url: string) =>
    apiRequest<SocialLinkItem[]>('/users/me/social-links', {
      method: 'POST',
      body: JSON.stringify({ platform, url }),
    }),
  setHidden: (id: string, hidden: boolean) =>
    apiRequest<SocialLinkItem[]>(`/users/me/social-links/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  remove: (id: string) =>
    apiRequest<SocialLinkItem[]>(`/users/me/social-links/${id}`, { method: 'DELETE' }),
  setPublic: (isPublic: boolean) =>
    apiRequest<void>('/users/me/social-profile', {
      method: 'PATCH',
      body: JSON.stringify({ public: isPublic }),
    }),
}

export interface SavedTerms {
  id: string
  label: string
  body: string
  createdAt: string
}

export const savedTermsApi = {
  getAll: () =>
    apiRequest<SavedTerms[]>('/saved-terms'),
  add: (data: { label: string; body: string }) =>
    apiRequest<SavedTerms>('/saved-terms', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  remove: (id: string) =>
    apiRequest<void>(`/saved-terms/${id}`, { method: 'DELETE' }),
}

export interface SavedDeliveryAddress {
  id: string
  coin: string
  network: string   // 'BEP20' | 'Aptos' | 'Binance' | 'Bitget' | 'Gate'
  address: string
  label: string
  hidden?: boolean
}

export const kycApi = {
  getStatus: () =>
    apiRequest<{ status: string; level: string | null; latestSubmission: KycDocument | null }>('/kyc/status'),
  submit: (data: {
    tier: 'basic' | 'enhanced'
    // CNIC + document photos are required for Basic only; Enhanced reuses the
    // approved Level 1 documents server-side.
    cnicNumber?: string
    legalName?: string
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
    return apiRequest<{ referrals: Array<{ id: string; username: string; joinedAt: string; status: string; source?: 'telegram' | 'web' }> }>('/referral/list' + qs)
  },
}

export interface AirdropStreak {
  count: number
  longest: number
  multiplier: number
  freezes: number
  brokenAt: string | null
  preBreakStreak: number
  canRepair: boolean
  repairCost: number
  repairsLeft: number
  checkedInToday: boolean
}

export interface AirdropLevel {
  level: string
  levelName: string
  discountPct: number
  cumulativePoints: number
  nextLevel: string | null
  pointsToNext: number | null
}

export interface AirdropStatus {
  enabled: boolean
  season: { index: number; name: string } | null
  totalPoints: number
  breakdown: { source: string; points: number }[]
  milestone: { current: number; target: number }
  streak: AirdropStreak | null
  level: AirdropLevel | null
  levelsLive: boolean
}

export interface AirdropLedgerEntry {
  id: string
  source: string
  points: number
  createdAt: string
  metadata?: unknown
}

export const airdropApi = {
  getStatus: () => apiRequest<AirdropStatus>('/airdrop'),
  getLedger: () => apiRequest<{ entries: AirdropLedgerEntry[] }>('/airdrop/ledger'),
  checkin: () =>
    apiRequest<{ streak: number; multiplier: number; alreadyToday: boolean; pointsAwarded: number }>(
      '/airdrop/checkin', { method: 'POST' },
    ),
  repairStreak: () => apiRequest<{ restored: number; cost: number }>('/airdrop/streak/repair', { method: 'POST' }),
  resetStreak: () => apiRequest<Record<string, never>>('/airdrop/streak/reset', { method: 'POST' }),
}

export interface AdminAirdropSeason {
  id: string
  index: number
  name: string
  status: string
  tokenPool: string | null
  participants: number
  totalPoints: number
  startedAt: string
  endedAt: string | null
}

export interface AdminAllocation {
  userId: string
  username: string
  email: string
  points: number
  level: string
  sharePct: number
  tokenAllocation: number | null
}

export const adminAirdropApi = {
  listSeasons: () => apiRequest<{ seasons: AdminAirdropSeason[] }>('/admin/airdrop/seasons'),
  createSeason: (name: string) =>
    apiRequest<AdminAirdropSeason>('/admin/airdrop/seasons', { method: 'POST', body: JSON.stringify({ name }) }),
  setPool: (id: string, tokenPool: number) =>
    apiRequest<Record<string, never>>(`/admin/airdrop/seasons/${id}/pool`, { method: 'PATCH', body: JSON.stringify({ tokenPool }) }),
  closeSeason: (id: string) =>
    apiRequest<Record<string, never>>(`/admin/airdrop/seasons/${id}/close`, { method: 'POST' }),
  allocations: (id: string) =>
    apiRequest<{ season: AdminAirdropSeason; totalPoints: number; pool: number | null; allocations: AdminAllocation[]; truncated: boolean }>(
      `/admin/airdrop/seasons/${id}/allocations`,
    ),
}

/** Download the COMPLETE allocation CSV (authed raw fetch — the endpoint returns
 *  text/csv, not JSON, so it bypasses apiRequest's JSON parsing). */
export async function fetchAirdropAllocationsCsv(seasonId: string): Promise<string> {
  const token = useAuthStore.getState().accessToken
  const res = await fetch(`${API_BASE}/api/v1/admin/airdrop/seasons/${seasonId}/allocations.csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to download allocations CSV')
  return res.text()
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
  status: 'payment_pending' | 'payment_uploaded' | 'payment_verified' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'awaiting_refund' | 'refund_pending' | 'refunded' | 'cancelled'
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
  failureReason?: string | null
  refundEligibleAt?: string | null
  platformMarginUsdt?: string | null
  affiliateDiscountUsdt?: string | null
  affiliateReferrer?: string | null
  discountUsdt?: string
  freeCode?: string | null
  isFreeGrant?: boolean
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
    apiRequest<{ chains: GasChain[]; promoEnabled?: boolean; referralEnabled?: boolean; freeCodeEnabled?: boolean }>('/gas-fee/chains'),

  getChainTokens: (chainSlug: string) =>
    apiRequest<GasTokensResponse>(`/gas-fee/chains/${chainSlug}/tokens`),

  createOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; idempotencyKey?: string; promoCode?: string; freeCode?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders', { method: 'POST', body: JSON.stringify(data) }),

  createPkrOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; pkrPaymentMethod: 'bank_transfer' | 'easypaisa' | 'jazzcash' | 'nayapay' | 'sadapay'; idempotencyKey?: string; promoCode?: string; freeCode?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/pkr', { method: 'POST', body: JSON.stringify(data) }),

  createCryptoOrder: (data: { tokenConfigId: string; amount: number; toAddress: string; paymentNetwork: 'TRC20' | 'BEP20' | 'ERC20' | 'APTOS'; idempotencyKey?: string; promoCode?: string; freeCode?: string }) =>
    apiRequest<GasOrder>('/gas-fee/orders/crypto', { method: 'POST', body: JSON.stringify(data) }),

  previewPromo: (data: { promoCode: string; tokenConfigId: string; amount: number }) =>
    apiRequest<{ valid: boolean; code: string; discountUsdt: number; discountPct: number; slotsLeft: number | null; message: string }>('/gas-fee/promo/preview', { method: 'POST', body: JSON.stringify(data) }),

  previewFreeCode: (data: { freeCode: string; tokenConfigId: string }) =>
    apiRequest<{ valid: boolean; code: string; kolLabel: string; gasTokenConfigId: string; amountNative: number; amountUsdt: number; slotsLeft: number; budgetLeftUsdt: number; message: string }>('/gas-fee/free-code/preview', { method: 'POST', body: JSON.stringify(data) }),

  getReferralSummary: () =>
    apiRequest<{ enabled: boolean; code: string | null; label: string | null; referralPct: number | null; referredCount: number; totalAccruedUsdt: number; availableUsdt: number; withdrawableUsdt: number; withdrawnUsdt: number; minWithdrawUsdt: number; kycOk: boolean; boundToReferrer: boolean }>('/gas-fee/referral/me'),
  applyReferral: (code: string) =>
    apiRequest<{ bound: boolean; referrerId: string | null }>('/gas-fee/referral/apply', { method: 'POST', body: JSON.stringify({ code }) }),
  setReferralLabel: (label: string | null) =>
    apiRequest<{ label: string | null }>('/gas-fee/referral/label', { method: 'POST', body: JSON.stringify({ label }) }),
  withdrawReferral: () =>
    apiRequest<{ withdrawnUsdt: number; newBalanceUsdt: number }>('/gas-fee/referral/withdraw', { method: 'POST' }),

  // Affiliate program (self-service, extends referrals)
  getAffiliateOverview: () =>
    apiRequest<{
      enabled: boolean
      status: 'none' | 'pending' | 'approved' | 'rejected'
      applicantNote: string | null
      rejectionReason: string | null
      caps: { maxMarginPct: number; minUserDiscountPct: number; maxLinks: number } | null
      links: Array<{ id: string; code: string; label: string | null; userDiscountPct: number; commissionPct: number; isActive: boolean; referredCount: number }>
      customLinkPolicy: { maxLinks: number; used: number; canCreate: boolean; cooldownUntil: string | null; userDiscountPct: number; commissionPct: number; isAffiliate: boolean }
      earnings: { enabled: boolean; code: string | null; label: string | null; referralPct: number | null; referredCount: number; totalAccruedUsdt: number; availableUsdt: number; withdrawableUsdt: number; withdrawnUsdt: number; minWithdrawUsdt: number; kycOk: boolean; boundToReferrer: boolean }
    }>('/gas-fee/affiliate/me'),
  getAffiliateQuote: (tokenConfigId: string) =>
    apiRequest<{ discountUsdt: number; discountPct: number; referrerLabel: string } | null>(`/gas-fee/affiliate/quote?tokenConfigId=${encodeURIComponent(tokenConfigId)}`),
  applyAffiliate: (data: { socials: Record<string, string>; note?: string }) =>
    apiRequest<{ status: string }>('/gas-fee/affiliate/apply', { method: 'POST', body: JSON.stringify(data) }),
  createAffiliateLink: (data: { code?: string; label?: string; userDiscountPct: number; commissionPct: number }) =>
    apiRequest<{ id: string; code: string; label: string | null; userDiscountPct: number; commissionPct: number; isActive: boolean; referredCount: number }>('/gas-fee/affiliate/links', { method: 'POST', body: JSON.stringify(data) }),
  updateAffiliateLink: (codeId: string, data: { label?: string | null; userDiscountPct?: number; commissionPct?: number; isActive?: boolean }) =>
    apiRequest<{ id: string; code: string; label: string | null; userDiscountPct: number; commissionPct: number; isActive: boolean; referredCount: number }>(`/gas-fee/affiliate/links/${codeId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // Self-service custom links (any user; standard split, capped + cooldown)
  createCustomLink: (data?: { code?: string | null; label?: string | null }) =>
    apiRequest<{ id: string; code: string; label: string | null; userDiscountPct: number; commissionPct: number; isActive: boolean; referredCount: number }>('/gas-fee/referral/custom-links', { method: 'POST', body: JSON.stringify({ code: data?.code ?? null, label: data?.label ?? null }) }),
  deleteCustomLink: (codeId: string) =>
    apiRequest<{ deleted: true }>(`/gas-fee/referral/custom-links/${codeId}`, { method: 'DELETE' }),

  getGiveaway: (code: string) =>
    apiRequest<{ code: string; kolLabel: string; thumbnailUrl: string | null; tokenSymbol: string; networkLabel: string; addressType: string; explorerBase: string | null; amountNative: string; amountUsd: number | null; winnerCount: number; entryCount: number; entryDeadline: string | null; requireKyc: boolean; status: string; open: boolean; alreadyEntered: boolean; winners: Array<{ username: string | null; address: string; txHash: string | null; explorerUrl: string | null; delivered: boolean }> }>(`/gas-fee/giveaway/${encodeURIComponent(code)}`),
  enterGiveaway: (data: { code: string; receivingAddress: string; email?: string }) =>
    apiRequest<{ entered: boolean }>('/gas-fee/giveaway/enter', { method: 'POST', body: JSON.stringify(data) }),

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

  // Request a refund on a PAID order that's stuck before delivery (e.g. empty hot wallet).
  requestRefund: (orderRef: string, trackingToken?: string) =>
    apiRequest<{ orderRef: string; status: string }>(
      `/gas-fee/orders/${orderRef}/request-refund`, { method: 'POST', body: JSON.stringify(trackingToken ? { token: trackingToken } : {}) }),
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
  isArchived?: boolean
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
  isArchived?: boolean
  deliveryLive?: boolean
  // False when the backend delivery engine cannot send this token on its chain —
  // the token stays "coming soon" publicly regardless of any admin flags.
  engineSupported?: boolean
  displayOrder: number
  createdAt: string
  updatedAt: string
  chain?: { name: string; slug: string; backendChainId?: string | null }
}

export const adminApi = {
  // Dashboard
  getStats: (range?: 'today' | '7d' | '30d' | '1y' | 'all') =>
    apiRequest<{
      range: 'today' | '7d' | '30d' | '1y' | 'all'
      pendingKyc: number
      openDisputes: number
      pendingWithdrawals: number
      pendingInstantBuy: number
      todayVolumePkr: string
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
      todayGasVolumeUsdt: string
      todayGasRevenueUsdt: string
      totalGasOrders: number
      totalGasVolumeUsdt: string
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
    }>('/admin/dashboard/stats' + (range ? `?range=${range}` : '')),

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
    apiRequest<{ submissions: unknown[]; pagination: { total: number; page: number; limit: number; pages: number } }>('/admin/kyc/queue' + buildQs(params)),
  getKycSubmission: (id: string) =>
    apiRequest<unknown>(`/admin/kyc/${id}`),
  // Streams a KYC document (front/back/selfie/video) through our API origin and
  // returns an object URL. Immune to CSP / cross-site issues that break direct
  // Cloudinary <img> loads. Caller must URL.revokeObjectURL when done.
  getKycDocUrl: (id: string, kind: 'front' | 'back' | 'selfie' | 'video') =>
    apiRequestBlob(`/admin/kyc/${id}/doc/${kind}`),
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
  getReferralGraph: () =>
    apiRequest<{
      nodes: Array<{ id: string; username: string; kycStatus: string; referrals: number; referredById: string | null }>
      edges: Array<{ source: string; target: string }>
    }>('/admin/referrals/graph'),
  getReferralsByCountry: () =>
    apiRequest<{ countries: Array<{ country: string; countryCode: string | null; count: number }>; total: number }>('/admin/referrals/by-country'),
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
  adminForceCompleteTrade: (id: string, reason: string) =>
    apiRequest<{ message: string }>(`/admin/trades/${id}/force-complete`, { method: 'POST', body: JSON.stringify({ reason }) }),

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

  // Deposits — on-chain deposit history (credited / pending / rejected)
  // Backend returns { deposits: [...], pagination: { page, limit, total, pages } }
  getDeposits: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ deposits: unknown[]; pagination: { page: number; limit: number; total: number; pages: number } }>('/admin/deposits' + buildQs(params)),
  forceCreditDeposit: (id: string, data: { reason: string; skipChainVerification?: boolean }) =>
    apiRequest<unknown>(`/admin/deposits/${id}/force-credit`, { method: 'POST', body: JSON.stringify(data) }),
  refreshDepositConfirmations: (id: string) =>
    apiRequest<unknown>(`/admin/deposits/${id}/refresh-confirmations`, { method: 'POST' }),
  rejectDeposit: (id: string, data: { reason: string }) =>
    apiRequest<void>(`/admin/deposits/${id}/reject`, { method: 'POST', body: JSON.stringify(data) }),
  getDepositDetectionHealth: () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiRequest<any>('/admin/deposits/detection-health'),
  runAptosStragglerSweep: () =>
    apiRequest<{ scanned: number; swept: number; skipped: number; failed: number; totalUsdt: number }>(
      '/admin/gas/aptos/sweep-stragglers',
      { method: 'POST' },
    ),
  getDepositAddressBalances: (id: string) =>
    apiRequest<{
      address: string
      balances: Array<{
        chain: string
        chainName: string
        nativeSymbol: string
        native: string | null
        tokens: Array<{ symbol: string; contract: string; decimals: number; balance: string }>
        error?: string
      }>
    }>(`/admin/deposit-addresses/${id}/balances`),
  sweepDepositAddress: (id: string, data: { chain: string; asset: string; destination?: string; reason: string }) =>
    apiRequest<{
      txHash: string
      chain: string
      asset: string
      symbol: string
      amount: string
      from: string
      destination: string
      gasTopUpTxHash?: string
    }>(`/admin/deposit-addresses/${id}/sweep`, { method: 'POST', body: JSON.stringify(data) }),

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
  // External wallet withdrawal of platform-owned revenue (safe headroom only)
  getWithdrawConfig: () =>
    apiRequest<{
      destinations: { evm: string | null; tron: string | null; aptos: string | null }
      withdrawable: Array<{
        token: string; chain: string; family: string | null; network: string | null
        onChain: number; userLiability: number; pendingOut: number; buffer: number
        available: number; destinationSet: boolean; supported: boolean
      }>
    }>('/admin/platform-revenue/withdraw-config'),
  setWithdrawDestination: (data: { family: 'evm' | 'tron' | 'aptos'; address: string }) =>
    apiRequest<{ family: string; address: string }>(
      '/admin/platform-revenue/withdraw-destination',
      { method: 'PUT', body: JSON.stringify(data) },
    ),
  withdrawRevenue: (data: { tokenSymbol: string; chain: string; amount?: number }) =>
    apiRequest<{
      txHash: string; destination: string; hotWalletAddress: string
      tokenSymbol: string; chain: string; amount: number
      hotWalletBalanceBefore: number; remainingAvailable: number
    }>('/admin/platform-revenue/withdraw', { method: 'POST', body: JSON.stringify(data) }),

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
  runMediaRetention: () =>
    apiRequest<{ deleted: number; scanned: number; days: number } | null>('/admin/media-retention/run', { method: 'POST' }),

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
  getDetectionProviders: () =>
    apiRequest<{
      networks: Array<{
        network: string
        label: string
        canDetect: boolean
        activeProvider: string | null
        providers: Array<{
          name: string
          role: string
          status: 'green' | 'yellow' | 'red' | 'unconfigured'
          detail: string
          latencyMs: number | null
          canDetect: boolean
        }>
      }>
      allCanDetect: boolean
      fetchedAt: string
    }>('/admin/gas/detection-providers'),
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
  refundGasOrder: (id: string, opts?: { mode?: 'auto' | 'manual'; toAddress?: string; toNetwork?: string }) =>
    apiRequest<{ message?: string }>(`/admin/gas/orders/${id}/refund`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),

  // Admin-initiated user contact + structured refund-address request
  searchSupportUsers: (q: string) =>
    apiRequest<{ id: string; name: string; username: string | null; email: string; avatarUrl: string | null }[]>(
      `/admin/support/users/search?q=${encodeURIComponent(q)}`,
    ),
  contactSupportUser: (userId: string, body?: string) =>
    apiRequest<{ conversationId: string }>('/admin/support/contact', {
      method: 'POST',
      body: JSON.stringify({ userId, ...(body ? { body } : {}) }),
    }),
  requestRefundAddress: (userId: string, orderRef: string, body?: string) =>
    apiRequest<{ conversationId: string; messageId: string }>('/admin/support/refund-request', {
      method: 'POST',
      body: JSON.stringify({ userId, orderRef, ...(body ? { body } : {}) }),
    }),
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
      friendlyAddress: string | null
      nativeSymbol: string
      nativeBalance: number | null
      nativeUsd: number | null
      tokens: Array<{
        symbol: string; name: string; contractAddress: string | null; logoUrl: string | null
        balance: number | null; decimals: number | null; usd: number | null; error: string | null
      }>
    }>(`/admin/gas/hot-wallet/${encodeURIComponent(chain)}/tokens`),
  getGasTokenDiagnostics: () =>
    apiRequest<{
      report: Array<{
        chainSlug: string; backendChainId: string | null; chainType: string | null; addressType: string | null
        rpcUrl: string; hotWalletAddress: string | null
        symbol: string; name: string | null; tokenType: string
        isActive: boolean; deliveryLive: boolean
        configuredAddress: string | null; canonicalAddress: string | null; addressMatchesCanonical: boolean | null
        probeOk: boolean | null; probeDecimals: number | null; probeError: string | null
        willShowInWalletView: boolean
        verdict: 'OK' | 'CANONICAL_UNKNOWN' | 'INACTIVE' | 'NOT_SUPPORTED' | 'RATE_LIMITED' | 'RPC_ERROR' | 'WRONG_ADDRESS' | 'ADDRESS_MISSING' | 'UNKNOWN_ERROR'
        remediation: string
      }>
      counts: Record<string, number>
    }>('/admin/gas/token-diagnostics'),
  fixGasTokenAddresses: () =>
    apiRequest<{ changes: Array<{ chain: string; symbol: string; from: string | null; to: string }> }>(
      '/admin/gas/token-diagnostics/fix-addresses', { method: 'POST' },
    ),

  // ── Gas promo codes (margin-only marketing discounts) ──────────────────────
  getGasPromoCodes: () =>
    apiRequest<Array<{
      id: string; code: string; ownerLabel: string
      tiers: Array<{ maxRedemptions: number; discountPct: number }>
      defaultDiscountPct: number; marginBudgetUsdt: number; marginSpentUsdt: number; budgetRemainingUsdt: number
      totalRedemptions: number; redemptionRows: number; perUserLimit: number; minOrderUsd: number
      expiresAt: string | null; isActive: boolean; createdAt: string
    }>>('/admin/gas/promo-codes'),
  getGasPromoRedemptions: (id: string) =>
    apiRequest<Array<{ id: string; identity: string; discountUsdt: string; marginUsdt: string; tierIndex: number; createdAt: string; order: { orderRef: string; paymentAmount: string; status: string } | null }>>(`/admin/gas/promo-codes/${id}/redemptions`),
  createGasPromoCode: (data: {
    code: string; ownerLabel: string
    tiers: Array<{ maxRedemptions: number; discountPct: number }>
    defaultDiscountPct: number; marginBudgetUsdt: number; perUserLimit: number; minOrderUsd: number; expiresAt?: string
  }) => apiRequest<unknown>('/admin/gas/promo-codes', { method: 'POST', body: JSON.stringify(data) }),
  updateGasPromoCode: (id: string, data: Record<string, unknown>) =>
    apiRequest<unknown>(`/admin/gas/promo-codes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // ── Gas KOL free codes (100%-free, self-serve, slot + budget capped) ────────
  getGasFreeCodes: () =>
    apiRequest<Array<{
      id: string; code: string; kolLabel: string; gasTokenConfigId: string
      tokenSymbol: string | null; chainName: string | null
      amountNative: string
      slotLimit: number; redeemedCount: number; slotsRemaining: number
      budgetUsdt: number; spentUsdt: number; budgetRemainingUsdt: number
      perUserLimit: number
      expiresAt: string | null; isActive: boolean; redemptionRows: number; createdAt: string
    }>>('/admin/gas/free-codes'),
  getGasFreeCodeRedemptions: (id: string) =>
    apiRequest<Array<{ id: string; identity: string; amountUsdt: string; createdAt: string; order: { orderRef: string; gasAmountNative: string; status: string; toAddress: string } | null }>>(`/admin/gas/free-codes/${id}/redemptions`),
  createGasFreeCode: (data: {
    code: string; kolLabel: string; gasTokenConfigId: string; amountNative: number
    slotLimit: number; budgetUsdt: number; perUserLimit: number; expiresAt?: string
  }) => apiRequest<unknown>('/admin/gas/free-codes', { method: 'POST', body: JSON.stringify(data) }),
  updateGasFreeCode: (id: string, data: Record<string, unknown>) =>
    apiRequest<unknown>(`/admin/gas/free-codes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Admin-issued free-gas delivery (platform funds base + margin; flag-gated)
  freeGasDeliver: (data: { tokenConfigId: string; amount: number; toAddress: string; userId?: string; note?: string }) =>
    apiRequest<{ orderRef: string; gasAmountNative: number; gasAmountUSD: string; fullCoverUsdt: string; chain: string }>(
      '/gas-fee/admin/free-deliver', { method: 'POST', body: JSON.stringify(data) }),

  // Gas referral overview (admin)
  getGasReferrals: () =>
    apiRequest<Array<{
      codeId: string; code: string; referralPct: number; isActive: boolean
      owner: { id: string; username: string | null; email: string | null; kycLevel: string }
      referredCount: number; totalAccruedUsdt: number; availableUsdt: number; withdrawnUsdt: number; createdAt: string
    }>>('/admin/gas/referrals'),
  updateGasReferral: (codeId: string, data: { referralPct?: number; isActive?: boolean }) =>
    apiRequest<unknown>(`/admin/gas/referrals/${codeId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Gas affiliates (admin: applications + approval)
  getGasAffiliates: () =>
    apiRequest<Array<{
      userId: string; email: string | null; username: string | null; referralCode: string | null
      status: 'none' | 'pending' | 'approved' | 'rejected'
      socials: Record<string, string> | null; applicantNote: string | null; rejectionReason: string | null
      maxMarginPct: number; minUserDiscountPct: number; maxLinks: number; linkCount: number
      reviewedAt: string | null; createdAt: string
    }>>('/admin/gas/affiliates'),
  reviewGasAffiliate: (userId: string, data: { decision: 'approve' | 'reject'; maxMarginPct?: number; minUserDiscountPct?: number; maxLinks?: number; rejectionReason?: string | null }) =>
    apiRequest<{ status: string }>(`/admin/gas/affiliates/${userId}/review`, { method: 'POST', body: JSON.stringify(data) }),

  // Gas giveaways (admin)
  getGasGiveaways: () =>
    apiRequest<Array<{ id: string; code: string; kolLabel: string; thumbnailUrl: string | null; gasTokenConfigId: string; amountNative: string; winnerCount: number; drawnCount: number; selectedCount: number; sentCount: number; entryCount: number; entryDeadline: string | null; requireKyc: boolean; status: string; isActive: boolean; createdAt: string }>>('/gas-fee/admin/giveaways'),
  createGasGiveaway: (data: { code: string; kolLabel: string; thumbnailUrl?: string; tokenConfigId: string; amountNative: number; winnerCount: number; entryDeadline?: string; requireKyc: boolean }) =>
    apiRequest<unknown>('/gas-fee/admin/giveaways', { method: 'POST', body: JSON.stringify(data) }),
  getGasGiveawayEntries: (id: string) =>
    apiRequest<Array<{ id: string; userId: string; email: string | null; receivingAddress: string; status: string; orderId: string | null; orderStatus: string | null; orderRef: string | null; createdAt: string }>>(`/gas-fee/admin/giveaways/${id}/entries`),
  drawGasGiveaway: (id: string, count?: number) =>
    apiRequest<{ selected: number; attempted: number }>(`/gas-fee/admin/giveaways/${id}/draw`, { method: 'POST', body: JSON.stringify(count ? { count } : {}) }),
  sendGasGiveaway: (id: string) =>
    apiRequest<{ sent: number; attempted: number; results: Array<{ entryId: string; ok: boolean; orderRef?: string; error?: string }> }>(`/gas-fee/admin/giveaways/${id}/send`, { method: 'POST' }),
  closeGasGiveaway: (id: string) =>
    apiRequest<{ status: string }>(`/gas-fee/admin/giveaways/${id}/close`, { method: 'POST' }),
  getGasNativeRate: (symbol: string) =>
    apiRequest<{ symbol: string; usdPrice: number; source: string }>(`/gas-fee/admin/native-rate?symbol=${encodeURIComponent(symbol)}`),
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
  archiveGasChain: (id: string, isArchived: boolean) =>
    apiRequest<AdminGasChain>(`/admin/gas/chains/${id}`, { method: 'PATCH', body: JSON.stringify({ isArchived }) }),

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
  archiveGasToken: (id: string, isArchived: boolean) =>
    apiRequest<AdminGasToken>(`/admin/gas/tokens/${id}`, { method: 'PATCH', body: JSON.stringify({ isArchived }) }),

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

  // ── Announcements (broadcast) ──
  getAnnouncementAudience: () =>
    apiRequest<{ bell: number; telegram: number }>('/admin/announcements/audience'),
  getAnnouncements: (params?: { page?: number; limit?: number }) =>
    apiRequest<{
      announcements: Announcement[]
      pagination: { page: number; limit: number; total: number; pages: number }
    }>('/admin/announcements' + buildQs(params as Record<string, string | number | undefined>)),
  createAnnouncement: (data: { title: string; body: string; linkUrl?: string; channels: AnnouncementChannel[] }) =>
    apiRequest<Announcement>('/admin/announcements', { method: 'POST', body: JSON.stringify(data) }),
  deactivateAnnouncement: (id: string) =>
    apiRequest<void>(`/admin/announcements/${id}/deactivate`, { method: 'PATCH' }),
}

export type AnnouncementChannel = 'web' | 'bell' | 'telegram'

export interface Announcement {
  id: string
  title: string
  body: string
  linkUrl: string | null
  channels: AnnouncementChannel[]
  isActive: boolean
  bellRecipients: number
  telegramSent: number
  telegramFailed: number
  createdAt: string
  sentByAdmin?: { username: string } | null
}

export interface AnnouncementBanner {
  id: string
  title: string
  body: string
  linkUrl: string | null
  createdAt: string
}

// User-facing announcement + notification-preference calls
export const announcementApi = {
  getActiveBanners: () =>
    apiRequest<{ banners: AnnouncementBanner[] }>('/announcements/active'),
  dismissBanner: (id: string) =>
    apiRequest<void>(`/announcements/${id}/dismiss`, { method: 'POST' }),
  getPreferences: () =>
    apiRequest<{ announcementsEnabled: boolean; marketingEmailsEnabled: boolean }>('/me/notification-preferences'),
  setAnnouncementsEnabled: (announcementsEnabled: boolean) =>
    apiRequest<{ announcementsEnabled: boolean }>('/me/notification-preferences', {
      method: 'PATCH',
      body: JSON.stringify({ announcementsEnabled }),
    }),
}

// ─── Blog / Content ───────────────────────────────────────────────────────────

export interface BlogPostSummary {
  slug: string
  title: string
  excerpt: string | null
  coverImageUrl: string | null
  coverImageAlt: string | null
  category: string | null
  subcategory: string | null
  tags: string[]
  authorName: string
  publishedAt: string | null
  readingMinutes: number
  viewCount?: number
}

export interface BlogPost extends BlogPostSummary {
  id: string
  bodyHtml: string
  coverImageCaption: string | null
  status: 'draft' | 'published'
  scheduledFor: string | null
  authorId: string | null
  metaTitle: string | null
  metaDescription: string | null
  focusKeyword: string | null
  ogImageUrl: string | null
  canonicalUrl: string | null
  noindex: boolean
  viewCount: number
  createdAt: string
  updatedAt: string
}

export interface BlogUpsert {
  title: string
  slug?: string
  excerpt?: string | null
  bodyHtml: string
  coverImageUrl?: string | null
  coverImageAlt?: string | null
  coverImageCaption?: string | null
  status?: 'draft' | 'published'
  tags?: string[]
  category?: string | null
  subcategory?: string | null
  authorName?: string
  metaTitle?: string | null
  metaDescription?: string | null
  focusKeyword?: string | null
  ogImageUrl?: string | null
  canonicalUrl?: string | null
  noindex?: boolean
}

export interface NewsletterSubscriber {
  id: string
  email: string
  source: string | null
  country: string | null
  ipAddress: string | null
  confirmed: boolean
  createdAt: string
}

export const blogApi = {
  // Public
  list: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ posts: BlogPostSummary[]; total: number; page: number; pageSize: number }>('/blog' + buildQs(params)),
  getBySlug: (slug: string) =>
    apiRequest<BlogPost>(`/blog/post/${encodeURIComponent(slug)}`),
  subscribe: (email: string, source?: string) =>
    apiRequest<{ success: boolean }>('/blog/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email, ...(source ? { source } : {}) }),
    }),
  // Admin
  adminList: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ posts: BlogPost[]; total: number; page: number; pageSize: number }>('/blog/admin' + buildQs(params)),
  adminGet: (id: string) =>
    apiRequest<BlogPost>(`/blog/admin/${id}`),
  adminCreate: (data: BlogUpsert) =>
    apiRequest<BlogPost>('/blog/admin', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdate: (id: string, data: Partial<BlogUpsert>) =>
    apiRequest<BlogPost>(`/blog/admin/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminDelete: (id: string) =>
    apiRequest<{ id: string }>(`/blog/admin/${id}`, { method: 'DELETE' }),
  adminSubscribers: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ subscribers: NewsletterSubscriber[]; total: number; page: number; pageSize: number }>('/blog/subscribers' + buildQs(params)),
}

// ─── Community Token Market ───────────────────────────────────────────────────

export type CtmPriceRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all'
export interface CtmPriceCandle { t: string; o: number; h: number; l: number; c: number; n: number }
export interface CtmPricePoint { t: string; p: number }
export interface CtmPriceHistory {
  range: CtmPriceRange
  currency: 'PKR'
  usdtPkrRate: number | null
  candles: CtmPriceCandle[]
  points: CtmPricePoint[]
  tradeCount: number
  bucketMs: number
  from: string
  to: string
  hasCandles: boolean
}

// USDT-marketplace price history — PKR per 1 USDT over time. Same shape as the
// CTM history minus the conversion rate (the price is already in PKR).
export interface UsdtPriceHistory {
  range: CtmPriceRange
  currency: 'PKR'
  candles: CtmPriceCandle[]
  points: CtmPricePoint[]
  tradeCount: number
  bucketMs: number
  from: string
  to: string
  hasCandles: boolean
}

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
    changePercent1h: number | null
    lastTradePrice: number | null
    lastTradedAt: string | null
    recentPrices: { price: number; at: string }[]
    dataSource: 'completed_trades' | 'active_listings' | 'none'
    sampleSize: number
    lowData: boolean
  }>(`/ctm/tokens/${tokenId}/market-insight`),
  getTokenPriceHistory: (tokenId: string, range: CtmPriceRange) => apiRequest<CtmPriceHistory>(
    `/ctm/tokens/${tokenId}/price-history` + buildQs({ range }),
  ),
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
  // CTM feature gates (currently: USDT-as-payment). Defaults false while the
  // feature is code-gated / flag-off, so the UI stays PKR-only until flipped.
  getCtmConfig: () =>
    apiRequest<{ usdtPaymentEnabled: boolean }>('/ctm/config'),
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
  startListingTrade: (id: string, data: { paymentMethod?: string; paymentMethods?: string[]; buyerSettlementId?: string; buyerPaymentMethodId?: string; acceptedBuyerPaymentMethodIds?: string[]; tokenAmount: number; usdtMethod?: string; usdtAddress?: string; usdtFromAddress?: string }) =>
    apiRequest<{ tradeRef: string }>(`/ctm/listings/${id}/trade`, { method: 'POST', body: JSON.stringify(data) }),

  // Listing bids
  placeListingBid: (listingId: string, data: { pricePerUnit: number; tokenAmount: number }) =>
    apiRequest<unknown>(`/ctm/listings/${listingId}/bids`, { method: 'POST', body: JSON.stringify(data) }),
  confirmBidDetails: (bidId: string, data: { paymentMethod?: string; paymentMethods?: string[]; buyerSettlementId?: string; buyerPaymentMethodId?: string; acceptedBuyerPaymentMethodIds?: string[]; message?: string }) =>
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
  acceptBid: (requestId: string, bidId: string, data: object = {}) => apiRequest<unknown>(`/ctm/requests/${requestId}/accept/${bidId}`, { method: 'POST', body: JSON.stringify(data) }),

  // Trades
  getMyTrades: (params?: Record<string, string | number | undefined>) =>
    apiRequest<{ trades: unknown[]; total: number; page: number; limit: number; totalPages: number }>('/ctm/trades' + buildQs(params)),
  getTrade: (ref: string) => apiRequest<unknown>(`/ctm/trades/${ref}`),
  uploadPaymentProof: (ref: string, formData: FormData) =>
    apiRequest<{ fileUrl: string }>(`/ctm/trades/${ref}/payment-proof`, { method: 'POST', body: formData }),
  confirmPayment: (ref: string) => apiRequest<void>(`/ctm/trades/${ref}/confirm-payment`, { method: 'POST' }),
  rejectPayment: (ref: string, data: { reason: string; detail: string }) =>
    apiRequest<{ outcome: 'bounced' | 'disputed'; rejectionCount: number; remaining?: number }>(`/ctm/trades/${ref}/reject-payment`, { method: 'POST', body: JSON.stringify(data) }),
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
  adminForceRelease: (ref: string, reason?: string) => apiRequest<void>(`/ctm/trades/admin/${ref}/release`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
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
  return sendAndParse<T>(`${API_BASE}/api/v1${path}`, options ?? {}, method, headers, path)
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
