'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Download, X, Share, Plus } from 'lucide-react'
import {
  INSTALL_PROMPT_EVENT,
  INSTALL_DISMISS_KEY,
  isRunningStandalone,
  isIosSafari,
  tryTelegramAddToHomeScreen,
  ensureServiceWorker,
  type BeforeInstallPromptEvent,
} from '@/lib/installApp'
import { isTelegramMiniApp } from '@/lib/telegram'

const DISMISS_DAYS = 30
// Idle fallback: if no high-intent open, offer install after a short browse.
const SHOW_AFTER_MS = 45 * 1000

type Mode = 'native' | 'ios' | 'telegram'

/**
 * Dismissible "Install RupChain" prompt. Captures the Chromium
 * `beforeinstallprompt` for a one-tap native install; falls back to iOS
 * Share-sheet instructions and Telegram's native add-to-home-screen. Hidden when
 * already installed (standalone). Snoozed 30 days on dismiss; can be re-opened
 * from Settings via openInstallPrompt().
 */
export function InstallAppBanner() {
  const [visible, setVisible] = useState(false)
  const [mode, setMode] = useState<Mode>('native')
  const [forced, setForced] = useState(false) // opened explicitly from Settings
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null)
  const shownRef = useRef(false)

  const snoozed = useCallback(() => {
    const at = Number(localStorage.getItem(INSTALL_DISMISS_KEY) ?? '0')
    return at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isRunningStandalone()) return // already installed — nothing to offer
    void ensureServiceWorker()

    const inTelegram = isTelegramMiniApp()
    const ios = isIosSafari()

    function show(m: Mode, force = false) {
      if (shownRef.current && !force) return
      shownRef.current = true
      setMode(m)
      setForced(force)
      setVisible(true)
    }

    // Chromium: capture the install event so we can trigger it on our own button.
    const onBIP = (e: Event) => {
      e.preventDefault()
      deferredRef.current = e as BeforeInstallPromptEvent
      if (!snoozed()) show('native')
    }
    window.addEventListener('beforeinstallprompt', onBIP)

    // If installed while open, hide.
    const onInstalled = () => { setVisible(false); localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())) }
    window.addEventListener('appinstalled', onInstalled)

    // Settings entry / manual trigger — always shows, ignoring snooze.
    const onOpen = () => {
      if (isRunningStandalone()) return
      show(inTelegram ? 'telegram' : ios ? 'ios' : 'native', true)
    }
    window.addEventListener(INSTALL_PROMPT_EVENT, onOpen)

    // Idle fallback for platforms with no beforeinstallprompt (iOS / Telegram).
    let timer: ReturnType<typeof setTimeout> | null = null
    if (!snoozed() && (ios || inTelegram)) {
      timer = setTimeout(() => show(inTelegram ? 'telegram' : 'ios'), SHOW_AFTER_MS)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener(INSTALL_PROMPT_EVENT, onOpen)
      if (timer) clearTimeout(timer)
    }
  }, [snoozed])

  function dismiss() {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()))
    setVisible(false)
  }

  async function installNative() {
    const evt = deferredRef.current
    if (!evt) return
    try {
      await evt.prompt()
      await evt.userChoice
    } catch { /* ignore */ } finally {
      deferredRef.current = null
      localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()))
      setVisible(false)
    }
  }

  function installTelegram() {
    const ok = tryTelegramAddToHomeScreen()
    if (!ok) setMode('ios') // very old TG client — show generic guidance
    else dismiss()
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] lg:bottom-4 right-4 z-50 max-w-sm w-[calc(100%-2rem)] sm:w-96 bg-surface border border-border shadow-card-md rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2">
      <button onClick={dismiss} aria-label="Dismiss" className="absolute top-3 right-3 text-text-muted hover:text-text-primary">
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
          <Download className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Install the RupChain app</p>

          {mode === 'ios' ? (
            <>
              <p className="text-xs text-text-muted mt-0.5">Add RupChain to your home screen for a full-screen, app-like experience:</p>
              <ol className="text-xs text-text-secondary mt-2 space-y-1.5">
                <li className="flex items-center gap-1.5">
                  <span className="font-semibold">1.</span> Tap <Share className="w-3.5 h-3.5 inline text-primary" /> <span className="font-medium">Share</span> in Safari&apos;s toolbar
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="font-semibold">2.</span> Choose <Plus className="w-3.5 h-3.5 inline text-primary" /> <span className="font-medium">Add to Home Screen</span>
                </li>
              </ol>
              <button onClick={dismiss} className="mt-3 px-3 py-1.5 border border-border text-text-secondary text-xs font-medium rounded-lg hover:bg-surface-alt transition-colors">
                Got it
              </button>
            </>
          ) : mode === 'telegram' ? (
            <>
              <p className="text-xs text-text-muted mt-0.5">Add RupChain to your phone&apos;s home screen for one-tap access.</p>
              <div className="flex gap-2 mt-3">
                <button onClick={installTelegram} className="px-3 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                  Add to Home Screen
                </button>
                <button onClick={dismiss} className="px-3 py-1.5 border border-border text-text-secondary text-xs font-medium rounded-lg hover:bg-surface-alt transition-colors">
                  Not now
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted mt-0.5">
                {deferredRef.current
                  ? 'Install RupChain for faster access, offline-ready shell and a full-screen experience.'
                  : forced
                  ? 'Use your browser menu → “Install app” / “Add to Home Screen” to install RupChain.'
                  : 'Install RupChain for faster access and a full-screen experience.'}
              </p>
              <div className="flex gap-2 mt-3">
                {deferredRef.current && (
                  <button onClick={installNative} className="px-3 py-1.5 bg-primary text-white text-xs font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                    Install app
                  </button>
                )}
                <button onClick={dismiss} className="px-3 py-1.5 border border-border text-text-secondary text-xs font-medium rounded-lg hover:bg-surface-alt transition-colors">
                  {deferredRef.current ? 'Not now' : 'Got it'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
