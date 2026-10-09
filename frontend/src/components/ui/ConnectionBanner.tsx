'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api'
import {
  beginRetry, endRetry, getConnectionState, reportConnectionFailure, reportConnectionSuccess,
  subscribeConnection, type ConnectionState,
} from '@/lib/connectionStatus'

/**
 * Small banner for connection trouble while the app is already open. It never
 * reloads the page or replays a request, so the current screen and anything the
 * user has typed stay as they are.
 *
 *  - "Reconnecting…" only while a request is actually being retried (and only
 *    after a short delay, so the routine instant retry of a dead socket after the
 *    phone wakes up does not flash a banner).
 *  - A connection failure and a server failure get different wording.
 *  - Recovery is checked with an uncached request to the API's health ping, on a
 *    bounded backoff, never with navigator.onLine alone.
 */
const SHOW_RETRY_AFTER_MS = 1_500
const PROBE_TIMEOUT_MS = 6_000
const PROBE_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]

export function ConnectionBanner() {
  const [state, setState] = useState<ConnectionState>(() => getConnectionState())
  const [shown, setShown] = useState<ConnectionState>('ok')
  const probing = useRef(false)
  const probeAttempt = useRef(0)

  useEffect(() => subscribeConnection(setState), [])

  // What is displayed follows the state, except a retry starting from a healthy
  // state waits SHOW_RETRY_AFTER_MS before it appears.
  useEffect(() => {
    if (state !== 'retrying') { setShown(state); return }
    if (shown !== 'ok') { setShown('retrying'); return }
    const t = setTimeout(() => setShown('retrying'), SHOW_RETRY_AFTER_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const probe = useCallback(async () => {
    if (probing.current) return
    probing.current = true
    beginRetry()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(`${API_BASE}/health/ping`, { cache: 'no-store', signal: controller.signal })
      if (res.ok) { probeAttempt.current = 0; reportConnectionSuccess() }
      else reportConnectionFailure('server')
    } catch {
      reportConnectionFailure('offline')
    } finally {
      clearTimeout(timer)
      endRetry()
      probing.current = false
    }
  }, [])

  // While there is a problem: re-check on a bounded backoff while the page is
  // visible, and straight away when the device reports it is back online or the
  // app returns to the foreground.
  // (A probe in flight shows as 'retrying'; only a real recovery resets the backoff.)
  useEffect(() => {
    if (state === 'ok') { probeAttempt.current = 0; return }
    if (state === 'retrying') return
    const delay = PROBE_DELAYS_MS[Math.min(probeAttempt.current, PROBE_DELAYS_MS.length - 1)]
    const t = setTimeout(() => {
      if (document.hidden) return
      probeAttempt.current += 1
      void probe()
    }, delay)
    const now = () => { if (!document.hidden) { probeAttempt.current = 0; void probe() } }
    window.addEventListener('online', now)
    document.addEventListener('visibilitychange', now)
    return () => {
      clearTimeout(t)
      window.removeEventListener('online', now)
      document.removeEventListener('visibilitychange', now)
    }
  }, [state, probe])

  if (shown === 'ok') return null

  const text = shown === 'retrying'
    ? 'Reconnecting…'
    : shown === 'server'
      ? 'RupChain is having trouble right now. Please try again in a moment.'
      : 'We couldn’t connect to RupChain just now. Please try again in a moment.'

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center px-4 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm text-text-primary shadow-lg"
      >
        <span
          aria-hidden
          className={`h-2 w-2 flex-shrink-0 rounded-full ${shown === 'retrying' ? 'bg-primary motion-safe:animate-pulse' : 'bg-warning'}`}
        />
        <span className="min-w-0 flex-1 leading-snug">{text}</span>
        {shown !== 'retrying' && (
          <button
            type="button"
            onClick={() => { probeAttempt.current = 0; void probe() }}
            className="flex-shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
