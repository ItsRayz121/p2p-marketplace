'use client'
import { useState, useEffect } from 'react'
import { subscribeToPush, savePushSubscription, unsubscribeFromPush } from '@/lib/push'
import { analytics } from '@/lib/analytics'
import { isTelegramMiniApp } from '@/lib/telegram'
import { Button } from './Button'

type PushState = 'loading' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'

export function PushToggle() {
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setState('denied')
      return
    }
    navigator.serviceWorker.register('/sw.js').then((reg) =>
      reg.pushManager.getSubscription().then((sub) => {
        setState(sub ? 'subscribed' : 'unsubscribed')
      }),
    ).catch(() => setState('unsubscribed'))
  }, [])

  const handleEnable = async () => {
    setBusy(true)
    try {
      const sub = await subscribeToPush()
      if (sub) {
        await savePushSubscription(sub)
        analytics.pushNotificationSubscribed()
        setState('subscribed')
      } else {
        setState(Notification.permission === 'denied' ? 'denied' : 'unsubscribed')
      }
    } catch {
      // ignore
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    try {
      await unsubscribeFromPush()
      setState('unsubscribed')
    } catch {
      // ignore
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') return null
  if (state === 'unsupported') return (
    <p className="text-sm text-text-muted">
      {isTelegramMiniApp()
        // Telegram's in-app WebView doesn't expose the Web Push API on every
        // platform (most consistently on iOS) — this is a Telegram/OS limit,
        // not an account setting. The bot DM already covers trade/security
        // alerts for linked accounts, so nothing is missed while this is off.
        ? "Browser push isn't available inside Telegram's app view on this device — you're still covered by alerts from this bot's DM. Open rupchain.com in your phone's regular browser to also enable browser push there."
        : 'Push notifications are not supported in this browser.'}
    </p>
  )
  if (state === 'denied') return (
    <p className="text-sm text-text-muted">
      Push notifications are blocked. Enable them in your browser settings to receive trade alerts.
    </p>
  )
  if (state === 'subscribed') return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-success font-medium">Push notifications enabled</span>
      <Button variant="secondary" size="sm" loading={busy} onClick={handleDisable}>Disable</Button>
    </div>
  )
  return (
    <Button size="sm" loading={busy} onClick={handleEnable}>
      Enable push notifications
    </Button>
  )
}
