'use client'
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { authApi, miniAppAuthenticate, isNetworkError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { initPostHog, identifyUser } from '@/lib/analytics'
import { isTelegramMiniApp } from '@/lib/telegram'
import { initConnectionWarmup } from '@/lib/connectionWarmup'
import { TotpPrompt } from '@/components/providers/TotpPrompt'

interface ProvidersProps {
  children: React.ReactNode
}

// Public / guest routes that must NEVER render their signup-or-marketing UI
// inside Telegram — the bot often advertises the bare root URL, so "/" is
// guarded too. Matched by exact "/" or prefix for the rest. Telegram users are
// bounced to the "/mini-app" auth bridge instead (Rule #5). This runs
// client-side because the launch hash that proves "we're in Telegram" never
// reaches the Vercel edge middleware.
const TELEGRAM_REDIRECT_PREFIXES = [
  '/login',
  '/register',
  '/forgot-password',
  '/verify-email',
  '/r/',
  '/invite',
  '/join',
]

function isGuardedPublicPath(pathname: string): boolean {
  if (pathname === '/') return true
  return TELEGRAM_REDIRECT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
}

export default function Providers({ children }: ProvidersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)
  const setCsrfToken = useAuthStore((s) => s.setCsrfToken)
  const setLoading = useAuthStore((s) => s.setLoading)
  const clearAuth = useAuthStore((s) => s.clearAuth)

  // ── Telegram route guard ──
  // Bounce guarded public routes to the auth bridge. Skips "/mini-app" itself.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isTelegramMiniApp()) return
    if (pathname === '/mini-app') return
    if (isGuardedPublicPath(pathname)) {
      router.replace('/mini-app')
    }
  }, [pathname, router])

  // Replace connections the carrier reaped while we were backgrounded, BEFORE the
  // page's real reads go out — see lib/connectionWarmup.
  useEffect(() => initConnectionWarmup(), [])

  useEffect(() => {
    initPostHog()

    async function init() {
      setLoading(true)
      // CSRF doesn't depend on the session, so fetch it in PARALLEL with the
      // refresh→me auth chain instead of after it — removes one sequential
      // round-trip from the cold-start critical path (noticeable on mobile).
      const csrfPromise = authApi.getCsrf()
        .then((csrfData) => setCsrfToken(csrfData.token))
        .catch(() => { /* non-fatal */ })
      try {
        if (isTelegramMiniApp()) {
          // Inside Telegram the cross-site refresh cookie is blocked — bootstrap
          // (and silently re-issue) the session from the launch-hash initData.
          // This covers reloads on deep routes, not just the bridge.
          try { sessionStorage.removeItem('tg_auth_error') } catch { /* ignore */ }
          const data = await miniAppAuthenticate()
          setAccessToken(data.accessToken)
          setUser(data.user)
          identifyUser(data.user.id, { email: data.user.email, role: data.user.role, kycLevel: data.user.kycLevel })
        } else {
          const refreshData = await authApi.refresh()
          setAccessToken(refreshData.accessToken)
          const user = await authApi.me()
          setUser(user)
          identifyUser(user.id, { email: user.email, role: user.role, kycLevel: user.kycLevel })
        }
      } catch (err) {
        // Stash the real failure reason so the Mini App bridge can show it
        // (e.g. NO_INITDATA vs HTTP_401 vs NETWORK) — invaluable for diagnosing
        // sign-in problems we can't reproduce off-device.
        if (isTelegramMiniApp()) {
          try { sessionStorage.setItem('tg_auth_error', err instanceof Error ? err.message : 'unknown') } catch { /* ignore */ }
        }
        // A transport failure means we never learned whether the session is valid —
        // the refresh cookie is still sitting on the device. Clearing auth here would
        // show a spurious "logged out" to someone whose only problem is a sleeping
        // radio, and would drop the hint cookie the middleware uses to keep them on
        // their page. Leave the session alone; the next request re-auths cleanly.
        if (!isNetworkError(err)) {
          // Not logged in — drop any stale hint cookie so the middleware
          // doesn't keep us on /dashboard with an expired backend session.
          clearAuth()
        }
      }

      // Ensure CSRF has settled (it ran alongside auth) before we clear loading.
      await csrfPromise
      setLoading(false)
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {children}
      <TotpPrompt />
    </ToastPrimitive.Provider>
  )
}
