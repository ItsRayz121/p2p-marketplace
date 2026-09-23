'use client'
import { create } from 'zustand'
import { setAuthHint, clearAuthHint } from '../lib/authCookie'

export interface AuthUser {
  id: string
  email: string
  fullName: string
  username: string
  role: 'user' | 'merchant' | 'kyc_reviewer' | 'dispute_agent' | 'support_agent' | 'admin' | 'super_admin'
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected'
  kycLevel: 'none' | 'basic' | 'enhanced'
  referralCode: string
  isEmailVerified: boolean
  twoFaEnabled: boolean
  // Account-linking state (see Settings → Connections)
  telegramLinked: boolean
  telegramUsername: string | null
  hasRealEmail: boolean
  dailyBuyUsed: number
  dailyBuyLimit: number
  createdAt: string
  withdrawalLockedUntil: string | null
  withdrawalLockReason: string | null
  avatarUrl: string | null
  usernameChangedAt: string | null
  tradeStats: {
    badge: 'new' | 'active' | 'trusted' | 'top' | 'elite'
    badgeLabel: string
    trustScore: number
    completedTrades: number
    completionRate: number
    avgRating: number
    totalTrades: number
  } | null
}

interface AuthStore {
  accessToken: string | null
  csrfToken: string | null
  user: AuthUser | null
  isLoading: boolean
  setAccessToken: (token: string) => void
  setCsrfToken: (token: string) => void
  setUser: (user: AuthUser) => void
  setLoading: (loading: boolean) => void
  clearAuth: () => void
}

// ─── Last-known-user cache ───────────────────────────────────────────────────
//
// Every previous load of this store started `user: null, isLoading: true` no
// matter what — so every single app open, on web, the installed PWA and the
// Telegram Mini App alike, blocked the ENTIRE signed-in shell behind a bare
// spinner until a full refresh()+me() (or Telegram's miniAppAuthenticate())
// round trip finished. On a slow or cold-starting connection that's multiple
// seconds of blank app on every visit, not just the first one.
//
// This is NOT a security boundary and grants nothing by itself — no
// authenticated API call can succeed without a live access token, which still
// only ever comes from the real reconciliation Providers.tsx runs on every
// mount, cache or no cache. What it buys is purely a first-paint shortcut: a
// RETURNING visit can render "signed in as you" immediately from the last
// snapshot, while that same background reconciliation quietly confirms or
// corrects it. Worst case on a stale/wrong cache — role changed, KYC status
// changed, or the session actually expired — is a flash of the old state for
// under a second before the background check overwrites or clears it, because
// that check always still runs regardless of whether the cache was used.
//
// Cleared on any logout / confirmed-invalid-session (see clearAuth below), so
// it does not linger on a shared device past the point the real session ends.
const CACHE_KEY = 'rupchain_cached_user'

function readCachedUser(): AuthUser | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

function writeCachedUser(user: AuthUser | null): void {
  if (typeof window === 'undefined') return
  try {
    if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user))
    else localStorage.removeItem(CACHE_KEY)
  } catch { /* storage full / blocked (private mode) — cache is best-effort only */ }
}

const cachedUser = readCachedUser()

export const useAuthStore = create<AuthStore>((set) => ({
  accessToken: null,
  csrfToken: null,
  user: cachedUser,
  // A genuinely cold, never-before-seen load has nothing to show and must
  // wait for the real network round trip — that's the only case this starts
  // `true` for. Anything with a cached snapshot starts `false` so the signed-in
  // shell renders immediately instead of gating on that round trip.
  isLoading: cachedUser === null,
  setAccessToken: (token) => set({ accessToken: token }),
  setCsrfToken: (token) => set({ csrfToken: token }),
  setUser: (user) => {
    // Mirror authenticated state into a non-HttpOnly cookie on the frontend
    // domain so the Next.js middleware (running on Vercel) can gate routes.
    // The real refresh_token cookie lives on the Railway backend domain and
    // is not visible to Vercel.
    setAuthHint(user.role)
    writeCachedUser(user)
    set({ user })
  },
  setLoading: (loading) => set({ isLoading: loading }),
  clearAuth: () => {
    clearAuthHint()
    writeCachedUser(null)
    set({ accessToken: null, user: null })
  },
}))
