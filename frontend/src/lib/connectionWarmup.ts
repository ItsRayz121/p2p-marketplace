'use client'
import { API_BASE } from './api'

// ─── Connection warm-up ──────────────────────────────────────────────────────
//
// The frontend (Vercel) and the API (Railway) are separate origins, so the
// browser keeps long-lived connections open to the API. When the app is
// backgrounded — an installed PWA, or the Telegram Mini App WebView — the phone's
// radio sleeps and the carrier NAT silently drops those idle TCP connections
// without telling the browser. On resume the browser cheerfully reuses a socket
// it believes is alive but which is already dead, and the first request out of
// the gate fails instantly with "Failed to fetch".
//
// apiRequest already retries that failure, so nothing breaks. But the retry costs
// the user a visible stall on the request they actually care about. So the moment
// we come back to the foreground we spend one throwaway request on /health/ping:
// it absorbs the dead socket (the browser evicts it from the pool on failure) and
// leaves a live connection behind, so the page's real reads land on a warm path.
//
// /health/ping is deliberately the target: it touches no DB and no Redis, and it
// carries no Authorization header, so it is a "simple" CORS request that needs no
// preflight. It is the cheapest possible way to prove the socket.

/** Only warm up after a background long enough for the connection to have been reaped. */
const HIDDEN_THRESHOLD_MS = 20_000
const PING_TIMEOUT_MS = 6_000
const PING_ATTEMPTS = 2

let hiddenSince: number | null = null
let inFlight = false

async function warmConnection(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    for (let attempt = 1; attempt <= PING_ATTEMPTS; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
      try {
        await fetch(`${API_BASE}/health/ping`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        })
        return // a live socket is now in the pool
      } catch {
        // Expected on the first attempt when the socket was dead. Absorbing that
        // failure here — instead of on a page's real read — is the whole point.
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    inFlight = false
  }
}

/** Wire up the foreground/online triggers. Returns a cleanup function. */
export function initConnectionWarmup(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now()
      return
    }
    const awayMs = hiddenSince === null ? 0 : Date.now() - hiddenSince
    hiddenSince = null
    if (awayMs >= HIDDEN_THRESHOLD_MS) void warmConnection()
  }

  // The radio just came back — whatever sockets we held are almost certainly stale.
  const onOnline = () => { void warmConnection() }

  // Restored from the back/forward cache: the page resumes with its old (dead)
  // connection pool, which is the same trap as a resumed WebView.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) void warmConnection()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('pageshow', onPageShow)

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('pageshow', onPageShow)
  }
}
