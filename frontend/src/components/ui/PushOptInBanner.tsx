'use client'
import { useState, useEffect, useRef } from 'react'
import { Bell, X } from 'lucide-react'
import { subscribeToPush, savePushSubscription } from '@/lib/push'
import { analytics } from '@/lib/analytics'
import { PUSH_PROMPT_EVENT, type PushPromptTrigger } from '@/lib/pushPrompt'

const DISMISS_KEY = 'push_optin_dismissed_at'
const DISMISS_DAYS = 30
// Idle fallback for users who never hit a high-intent moment.
const SHOW_AFTER_MS = 3 * 60 * 1000

const COPY: Record<PushPromptTrigger, { title: string; body: string }> = {
  timer: {
    title: 'Stay updated on your trades',
    body: 'Get alerts for trade updates, disputes, deposits, withdrawals and support replies — even when this tab is closed.',
  },
  trade: {
    title: "Don't miss the other trader's reply",
    body: 'Get an instant alert the moment payment is marked, confirmed or released — even if you close this tab.',
  },
}

/**
 * Gentle, dismissible browser-push opt-in (two-step soft prompt). It never
 * fires the native permission prompt on its own — that only happens if the
 * user clicks "Enable". Shown either at a high-intent moment (via
 * promptPushOptIn, e.g. entering an active trade) or after an idle timer as
 * fallback. Snoozed for 30 days when dismissed.
 */
export function PushOptInBanner() {
  const [visible, setVisible] = useState(false)
  const [trigger, setTrigger] = useState<PushPromptTrigger>('timer')
  const [busy, setBusy] = useState(false)
  const shownRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
    if (Notification.permission !== 'default') return // already granted or denied

    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? '0')
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000) return

    function show(t: PushPromptTrigger) {
      if (shownRef.current) return
      shownRef.current = true
      setTrigger(t)
      setVisible(true)
      analytics.pushPromptShown({ trigger: t })
    }

    const onPrompt = (e: Event) => {
      const t = (e as CustomEvent<{ trigger?: PushPromptTrigger }>).detail?.trigger
      show(t ?? 'trade')
    }
    window.addEventListener(PUSH_PROMPT_EVENT, onPrompt)
    const timer = setTimeout(() => show('timer'), SHOW_AFTER_MS)
    return () => {
      window.removeEventListener(PUSH_PROMPT_EVENT, onPrompt)
      clearTimeout(timer)
    }
  }, [])

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setVisible(false)
    analytics.pushPromptDismissed({ trigger })
  }

  async function enable() {
    setBusy(true)
    try {
      const sub = await subscribeToPush()
      if (sub) {
        await savePushSubscription(sub)
        analytics.pushNotificationSubscribed({ trigger })
      }
    } catch { /* ignore */ } finally {
      setBusy(false)
      // Whatever the outcome, don't keep nagging.
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
      setVisible(false)
    }
  }

  if (!visible) return null

  const copy = COPY[trigger]

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm w-[calc(100%-2rem)] sm:w-96 bg-surface border border-border shadow-card-md rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2">
      <button onClick={dismiss} aria-label="Dismiss" className="absolute top-3 right-3 text-text-muted hover:text-text-primary">
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
          <Bell className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{copy.title}</p>
          <p className="text-xs text-text-muted mt-0.5">{copy.body}</p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={enable}
              disabled={busy}
              className="px-3 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {busy ? 'Enabling…' : 'Enable notifications'}
            </button>
            <button
              onClick={dismiss}
              className="px-3 py-1.5 border border-border text-text-secondary text-xs font-medium rounded-lg hover:bg-surface-alt transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
