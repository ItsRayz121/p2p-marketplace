'use client'
import { useEffect, useState } from 'react'
import { BrandLogo } from '@/components/ui/BrandLogo'

/**
 * Branded startup state shown while the session is being established. Never an endless spinner:
 *  - after SLOW_MS it says it is taking longer than usual,
 *  - after GIVE_UP_MS it stops animating and offers an explicit Retry,
 *  - offline / reconnecting is announced separately.
 * Respects prefers-reduced-motion (no pulse, no spin — just text).
 * Nothing the user typed lives here, so Retry (a reload) loses nothing.
 */
const SLOW_MS = 6_000
const GIVE_UP_MS = 15_000

export function StartupLoader({ fullScreen = false, label = 'Loading RupChain' }: { fullScreen?: boolean; label?: string }) {
  const [elapsed, setElapsed] = useState(0)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - t0), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync) }
  }, [])

  const stalled = elapsed >= GIVE_UP_MS
  const slow = elapsed >= SLOW_MS
  const message = !online
    ? "You're offline. We'll reconnect automatically when your connection returns."
    : stalled
      ? "We couldn't finish loading. Your connection may be unstable."
      : slow
        ? 'Taking longer than usual…'
        : label

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-4 px-6 text-center ${fullScreen ? 'min-h-[100dvh] bg-surface' : 'min-h-[60vh]'}`}
    >
      <BrandLogo size={56} className="h-14 w-14 motion-safe:animate-pulse" priority />
      {!stalled && online && (
        <span className="h-1 w-24 overflow-hidden rounded-full bg-surface-alt" aria-hidden>
          <span className="block h-full w-1/2 rounded-full bg-primary motion-safe:animate-[startup-slide_1.4s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:opacity-40" />
        </span>
      )}
      <p className="max-w-xs text-sm text-text-secondary">{message}</p>
      {(stalled || !online) && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Retry
        </button>
      )}
      <style>{`@keyframes startup-slide{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}`}</style>
    </div>
  )
}
