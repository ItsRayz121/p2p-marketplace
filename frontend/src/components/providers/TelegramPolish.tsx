'use client'
// Optional Telegram Mini App polish — mounted globally. Everything here is
// best-effort: it loads the SDK lazily and no-ops entirely outside Telegram or
// if the SDK never loads. It NEVER gates auth or navigation.
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { isTelegramMiniApp, loadTelegramSdk, applyTelegramChrome, getWebApp } from '@/lib/telegram'
import { noteInAppNavigation, goBackSafe } from '@/lib/nav'

export default function TelegramPolish() {
  const router = useRouter()
  const pathname = usePathname()
  // Flips true once the Telegram SDK has loaded, so the BackButton effect below
  // re-runs and actually wires the button on the FIRST screen (fixes the race
  // where the SDK wasn't ready yet on cold-open / deep-link).
  const [sdkReady, setSdkReady] = useState(false)
  // Skip counting the very first pathname value (initial mount is not a nav).
  const mountedRef = useRef(false)

  // Track in-app navigation app-wide (Telegram AND web) so goBackSafe knows
  // whether back() will stay inside the app. Runs regardless of Telegram.
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    noteInAppNavigation()
  }, [pathname])

  // One-time: load SDK, expand to full height, sync theme chrome.
  useEffect(() => {
    if (!isTelegramMiniApp()) return
    void loadTelegramSdk().then((wa) => {
      if (!wa) return
      try {
        wa.ready?.()
        wa.expand?.()
      } catch { /* noop */ }
      applyTelegramChrome(wa)
      setSdkReady(true)
    })
  }, [])

  // BackButton ↔ router. Show on every route except the top-level dashboard;
  // tapping it navigates back (with a safe fallback so it never closes the app
  // from a deep-linked entry). Re-evaluated on each route change AND once the
  // SDK becomes ready, so it's wired even on the first screen.
  useEffect(() => {
    if (!isTelegramMiniApp()) return
    const wa = getWebApp()
    const back = wa?.BackButton
    if (!back) return

    const onBack = () => goBackSafe(router, '/dashboard')

    const atRoot = pathname === '/dashboard' || pathname === '/mini-app'
    try {
      if (atRoot) {
        back.hide()
      } else {
        back.show()
        back.onClick(onBack)
      }
    } catch { /* noop */ }

    return () => {
      try { back.offClick(onBack) } catch { /* noop */ }
    }
  }, [pathname, router, sdkReady])

  return null
}
