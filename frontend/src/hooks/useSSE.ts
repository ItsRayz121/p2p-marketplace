'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '@/store/auth.store'

type SseHandler = (event: { type: string; payload?: unknown }) => void

function resolveApiBase(): string {
  if (process.env.NODE_ENV === 'development') return ''
  return (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
}

// Same rationale as connectionWarmup.ts's HIDDEN_THRESHOLD_MS: below this, a
// background tab/WebView hasn't been away long enough for the carrier NAT to
// have reaped the connection, so reconnecting would just be wasted churn.
const HIDDEN_THRESHOLD_MS = 20_000

/**
 * Connects to the SSE stream at /api/v1/sse and calls `onEvent` for each
 * server-pushed message. Reconnects automatically on error with exponential
 * back-off (capped at 30 s). Disconnects when the user logs out.
 *
 * Also force-reconnects on foreground/online resume. A backgrounded tab or
 * installed-app WebView freezes JS and networking, so the browser often never
 * notices the underlying socket died — no `onerror` fires, and the stream just
 * goes silent (notifications/chat stop updating) until something else happens
 * to trigger a reconnect. This is the same dead-socket-on-resume failure mode
 * `connectionWarmup.ts` fixed for plain fetch() requests, applied here to the
 * one long-lived connection that fix doesn't cover.
 */
export function useSSE(onEvent: SseHandler) {
  const accessToken = useAuthStore((s) => s.accessToken)
  const onEventRef = useRef(onEvent)
  const esRef = useRef<EventSource | null>(null)
  const retryRef = useRef(1000)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenSinceRef = useRef<number | null>(null)

  useEffect(() => { onEventRef.current = onEvent }, [onEvent])

  const connect = useCallback(() => {
    if (!accessToken) return
    if (typeof EventSource === 'undefined') return

    const base = resolveApiBase()

    const scheduleReconnect = () => {
      const delay = Math.min(retryRef.current, 30_000)
      retryRef.current = Math.min(delay * 2, 30_000)
      retryTimerRef.current = setTimeout(connect, delay)
    }

    // Mint a single-use ticket (authenticated via the Authorization header) and
    // connect with ?ticket=, so the long-lived JWT never appears in the SSE URL
    // (proxy/CDN/server logs, history, Referer).
    void (async () => {
      let ticket: string
      try {
        const res = await fetch(`${base}/api/v1/sse/ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          credentials: 'include',
        })
        if (!res.ok) { scheduleReconnect(); return }
        const raw = await res.json() as { data?: { ticket?: string }; ticket?: string }
        ticket = raw.data?.ticket ?? raw.ticket ?? ''
        if (!ticket) { scheduleReconnect(); return }
      } catch {
        scheduleReconnect()
        return
      }

      const url = `${base}/api/v1/sse?ticket=${encodeURIComponent(ticket)}`
      const es = new EventSource(url, { withCredentials: true })
      esRef.current = es

      es.onmessage = (e) => {
        retryRef.current = 1000
        try {
          const data = JSON.parse(e.data as string) as { type: string; payload?: unknown }
          if (data.type !== 'ping') onEventRef.current(data)
        } catch { /* ignore malformed */ }
      }

      es.onerror = () => {
        es.close()
        esRef.current = null
        scheduleReconnect()
      }
    })()
  }, [accessToken])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      esRef.current = null
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [connect])

  // Force-reconnect on resume — see the rationale in the hook's doc comment.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const forceReconnect = () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      esRef.current?.close()
      esRef.current = null
      retryRef.current = 1000
      connect()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = Date.now()
        return
      }
      const awayMs = hiddenSinceRef.current === null ? 0 : Date.now() - hiddenSinceRef.current
      hiddenSinceRef.current = null
      if (awayMs >= HIDDEN_THRESHOLD_MS) forceReconnect()
    }

    const onOnline = () => forceReconnect()

    // Restored from the back/forward cache: the page resumes with whatever
    // EventSource instance was live before it was frozen, same trap as above.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) forceReconnect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [connect])
}
