'use client'
// Auth BRIDGE — not a UI surface. A user who opens the Mini App lands here
// (directly via the bot's button, or redirected by the Telegram route guard).
// Authentication itself is performed ONCE by Providers (which calls
// miniAppAuthenticate from the launch-hash initData on mount for every Telegram
// route). This page just reflects that bootstrap's outcome and forwards to the
// SAME /dashboard web users get — no signup/login screen ever renders, and we
// avoid a second auth call / duplicate session.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/store/auth.store'
import { loadTelegramSdk, getInitData } from '@/lib/telegram'

export default function MiniAppBridge() {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const isLoading = useAuthStore((s) => s.isLoading)
  const [timedOut, setTimedOut] = useState(false)

  // Optional SDK polish — never blocks auth.
  useEffect(() => {
    void loadTelegramSdk().then((wa) => { try { wa?.ready?.(); wa?.expand?.() } catch { /* noop */ } })
  }, [])

  // Forward as soon as Providers has a session. A `?path=` query (set by the
  // bot's notification "Open" button) deep-links to the relevant screen; we
  // only honour internal absolute paths and otherwise land on the dashboard.
  useEffect(() => {
    if (!user) return
    let dest = '/dashboard'
    try {
      const p = new URLSearchParams(window.location.search).get('path')
      if (p && p.startsWith('/') && !p.startsWith('//')) dest = p
    } catch { /* ignore malformed query */ }
    router.replace(dest)
  }, [user, router])

  // Safety net: if bootstrap is still pending after ~20s, surface the error UI.
  // Kept generous on purpose — auth retries with backoff over a slow VPN / mobile
  // connection can legitimately run several seconds before succeeding, and we'd
  // rather keep showing the spinner than flash "couldn't sign you in" mid-request.
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 20_000)
    return () => clearTimeout(t)
  }, [])

  // Error only once bootstrap has finished (isLoading=false) with no user, or
  // after the safety timeout.
  const failed = (!isLoading && !user) || (timedOut && !user)

  // Diagnostics shown on the failure screen so a user can tell us WHY sign-in
  // failed on their device (we can't reproduce it off-device). Computed only
  // when failed so it reads the final state.
  const diag = failed && typeof window !== 'undefined'
    ? (() => {
        let reason = ''
        try { reason = sessionStorage.getItem('tg_auth_error') || '' } catch { /* ignore */ }
        const len = getInitData().length
        return `launch data: ${len > 0 ? `present (${len})` : 'MISSING'}${reason ? ` · ${reason}` : ''}`
      })()
    : ''

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-canvas px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary text-white font-black text-2xl flex items-center justify-center">
        R
      </div>
      {!failed ? (
        <>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-text-muted text-sm">Signing you in via Telegram…</p>
        </>
      ) : (
        <div className="space-y-3 max-w-sm">
          <h1 className="text-lg font-bold text-text-primary">Couldn&apos;t sign you in</h1>
          <p className="text-text-muted text-sm">
            We couldn&apos;t read your Telegram session. Please re-open the app from the bot,
            or open it in your browser.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white"
          >
            Try again
          </button>
          {diag && (
            <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-text-muted/70">
              {diag}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
