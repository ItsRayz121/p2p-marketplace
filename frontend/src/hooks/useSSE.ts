'use client'
import { useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '@/store/auth.store'

type SseHandler = (event: { type: string; payload?: unknown }) => void

function resolveApiBase(): string {
  if (process.env.NODE_ENV === 'development') return ''
  return (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
}

/**
 * Connects to the SSE stream at /api/v1/sse and calls `onEvent` for each
 * server-pushed message. Reconnects automatically on error with exponential
 * back-off (capped at 30 s). Disconnects when the user logs out.
 */
export function useSSE(onEvent: SseHandler) {
  const accessToken = useAuthStore((s) => s.accessToken)
  const onEventRef = useRef(onEvent)
  const esRef = useRef<EventSource | null>(null)
  const retryRef = useRef(1000)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
}
