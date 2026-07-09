// Client helpers for the "Install RupChain" (Add to Home Screen / PWA) flow.
//
// Surfaces the browser's install prompt on Android/desktop Chrome, guided
// instructions on iOS Safari (which has no beforeinstallprompt), and Telegram's
// native addToHomeScreen inside the Mini App. Any page can open the prompt via
// openInstallPrompt(); the InstallAppBanner listens for the event.

import { isTelegramMiniApp, getWebApp } from '@/lib/telegram'

export const INSTALL_PROMPT_EVENT = 'rupchain:open-install-prompt'
export const INSTALL_DISMISS_KEY = 'install_prompt_dismissed_at'

// The (non-standard, Chromium-only) beforeinstallprompt event shape.
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// Telegram's home-screen API (added in Bot API 8.0). Not in our minimal SDK type,
// so accessed via a widened cast — all calls are optional / guarded.
interface TelegramHomeScreen {
  addToHomeScreen?: () => void
  checkHomeScreenStatus?: (cb: (status: string) => void) => void
}

/** Open the install banner/prompt from anywhere (e.g. a Settings row). */
export function openInstallPrompt(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(INSTALL_PROMPT_EVENT))
}

/** True when the app is already running as an installed PWA (standalone display). */
export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
    // iOS Safari exposes navigator.standalone instead of display-mode.
    if ((window.navigator as Navigator & { standalone?: boolean }).standalone) return true
  } catch { /* ignore */ }
  return false
}

/** iOS Safari can't fire beforeinstallprompt — detect so we can show instructions. */
export function isIosSafari(): boolean {
  if (typeof window === 'undefined') return false
  const ua = window.navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const webkit = /WebKit/.test(ua)
  const notChrome = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
  return iOS && webkit && notChrome
}

/** Inside Telegram, try the native "Add to Home Screen". Returns true if invoked. */
export function tryTelegramAddToHomeScreen(): boolean {
  if (!isTelegramMiniApp()) return false
  const wa = getWebApp() as (TelegramHomeScreen | undefined)
  if (wa?.addToHomeScreen) {
    try { wa.addToHomeScreen(); return true } catch { /* fall through */ }
  }
  return false
}

/** Register the push/PWA service worker on load (idempotent). Required so the
 *  browser considers the app installable. Safe no-op without SW support. */
export async function ensureServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const existing = await navigator.serviceWorker.getRegistration('/sw.js')
    if (!existing) await navigator.serviceWorker.register('/sw.js')
  } catch { /* ignore — SW is best-effort */ }
}
