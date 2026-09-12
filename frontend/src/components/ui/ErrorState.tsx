import { useEffect, useRef } from 'react'
import { Button } from './Button'

interface ErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: ErrorStateProps) {
  // Most of the time this screen is showing because a request failed while the
  // device was briefly offline/asleep (mobile radio sleep, backgrounded tab),
  // not because anything is actually broken. Rather than making the user
  // notice the red screen and tap "Try again" themselves, retry automatically
  // the moment the signals that predict recovery fire — the tab regains focus
  // or the browser reports it's back online. Debounced so the two events (which
  // often fire together) can't double-retry.
  const lastRetryRef = useRef(0)
  useEffect(() => {
    if (!onRetry) return
    const fire = () => {
      const now = Date.now()
      if (now - lastRetryRef.current < 2000) return
      lastRetryRef.current = now
      onRetry()
    }
    const onOnline = () => fire()
    const onVisible = () => { if (!document.hidden) fire() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [onRetry])

  return (
    <div className="flex flex-col items-center justify-center h-full w-full gap-3 py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center">
        <svg className="w-6 h-6 text-danger" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-text-primary">{title}</p>
        {description && (
          <p className="text-sm text-text-muted max-w-xs">{description}</p>
        )}
      </div>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
