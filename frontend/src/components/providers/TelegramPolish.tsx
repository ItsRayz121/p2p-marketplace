'use client'
// Optional Telegram Mini App polish — mounted globally. Everything here is
// best-effort: it loads the SDK lazily and no-ops entirely outside Telegram or
// if the SDK never loads. It NEVER gates auth or navigation.
import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { isTelegramMiniApp, loadTelegramSdk, applyTelegramChrome, getWebApp } from '@/lib/telegram'

export default function TelegramPolish() {
  const router = useRouter()
  const pathname = usePathname()
  const readyRef = useRef(false)

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
      readyRef.current = true
    })
  }, [])

  // BackButton ↔ router. Show on every route except the top-level dashboard;
  // tapping it navigates back. Re-evaluated on each route change.
  useEffect(() => {
    if (!isTelegramMiniApp()) return
    const wa = getWebApp()
    const back = wa?.BackButton
    if (!back) return

    const onBack = () => {
      try { router.back() } catch { /* noop */ }
    }

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
  }, [pathname, router])

  return null
}
