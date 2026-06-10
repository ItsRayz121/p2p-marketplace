'use client'
// Auth BRIDGE — not a UI surface. A user who opens the Mini App lands here
// (directly via the bot's button, or redirected by the Telegram route guard).
// It authenticates off the launch-hash initData and forwards to the SAME
// /dashboard that web users get. No signup/login screen ever renders.
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { miniAppAuthenticate } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { isTelegramMiniApp, getInitData, loadTelegramSdk } from '@/lib/telegram'
import { identifyUser } from '@/lib/analytics'

type Phase = 'authenticating' | 'error'

export default function MiniAppBridge() {
  const router = useRouter()
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setUser = useAuthStore((s) => s.setUser)
  const [phase, setPhase] = useState<Phase>('authenticating')
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    // Fire optional SDK load for polish (theme/expand) — never block auth on it.
    void loadTelegramSdk().then((wa) => { try { wa?.ready?.(); wa?.expand?.() } catch { /* noop */ } })

    async function authenticate(attempt = 0): Promise<void> {
      // The launch hash is the source of truth. If it isn't there yet (SDK still
      // settling on a slow WebView) retry briefly before giving up.
      if (!getInitData() && !isTelegramMiniApp()) {
        if (attempt < 8) {
          setTimeout(() => void authenticate(attempt + 1), 400) // ~3.2s window
          return
        }
        setPhase('error')
        return
      }
      try {
        const data = await miniAppAuthenticate()
        setAccessToken(data.accessToken)
        setUser(data.user)
        identifyUser(data.user.id, { email: data.user.email, role: data.user.role, kycLevel: data.user.kycLevel })
        router.replace('/dashboard')
      } catch {
        if (attempt < 4) {
          setTimeout(() => void authenticate(attempt + 1), 600)
          return
        }
        setPhase('error')
      }
    }

    void authenticate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-canvas px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary text-white font-black text-2xl flex items-center justify-center">
        R
      </div>
      {phase === 'authenticating' ? (
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
            onClick={() => { ranRef.current = false; setPhase('authenticating'); window.location.reload() }}
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
