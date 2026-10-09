// Client helpers for the "Install RupChain" (Add to Home Screen / PWA) flow.
//
// Surfaces the browser's install prompt on Android/desktop Chrome, guided
// instructions on iOS Safari (which has no beforeinstallprompt), and Telegram's
// native addToHomeScreen inside the Mini App. Any page can open the prompt via
// openInstallPrompt(); the InstallAppBanner listens for the event.

import { isTelegramMiniApp, getWebApp } from '@/lib/telegram'
import { API_BASE } from '@/lib/api'

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

/** Register the service worker (idempotent). Safe no-op without SW support.
 *
 *  This is called from Providers, i.e. on EVERY page including the public
 *  marketing routes — not just the signed-in shell. That matters: an
 *  unregistered worker cannot catch a failed navigation, so before this the
 *  landing page had no protection at all and a dropped connection went
 *  straight to the browser's ERR_CONNECTION_RESET screen.
 *
 *  register() is called unconditionally rather than only when getRegistration()
 *  comes back empty: register() on an already-registered scope is a no-op that
 *  also triggers the browser's update check, which is how a new sw.js
 *  reaches installs that never navigate anywhere new.
 *
 *  Once a worker is active it is told the API origin, so its connection-problem
 *  page can check that the API (not just the website) answers before reloading. */
export async function ensureServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    if (!swListenerAttached) {
      swListenerAttached = true
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { type?: string; version?: string } | null
        // eslint-disable-next-line no-console
        if (d?.type === 'RC_SW_ACTIVATED') console.info('[RupChain] service worker activated:', d.version)
      })
    }
    const reg = await withTimeout(navigator.serviceWorker.ready, 10_000)
    reg?.active?.postMessage({ type: 'RC_SW_CONFIG', api: API_BASE })
  } catch { /* ignore — SW is best-effort */ }
}

let swListenerAttached = false

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

export interface ServiceWorkerDiagnostics {
  supported: boolean
  standalone: boolean
  registered: boolean
  scope: string | null
  scriptURL: string | null
  activeState: string | null
  waiting: boolean
  installing: boolean
  /** True when the current page is controlled by the worker (needed for the fallback page). */
  controlled: boolean
  /** Version string reported by the active worker; null = a worker from before diagnostics existed. */
  version: string | null
  fallbackCached: boolean | null
  lastCacheError: string | null
  apiConfigured: string | null
}

/** Ask the browser and the active worker what is actually installed on this device.
 *  `repair: true` also asks the worker to re-cache a missing fallback page. */
export async function getServiceWorkerDiagnostics(opts: { repair?: boolean } = {}): Promise<ServiceWorkerDiagnostics> {
  const out: ServiceWorkerDiagnostics = {
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    standalone: isRunningStandalone(),
    registered: false, scope: null, scriptURL: null, activeState: null,
    waiting: false, installing: false, controlled: false,
    version: null, fallbackCached: null, lastCacheError: null, apiConfigured: null,
  }
  if (!out.supported) return out
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    out.controlled = !!navigator.serviceWorker.controller
    if (!reg) return out
    out.registered = true
    out.scope = reg.scope
    out.scriptURL = (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL ?? null
    out.activeState = reg.active?.state ?? null
    out.waiting = !!reg.waiting
    out.installing = !!reg.installing
    if (reg.active) {
      const status = await new Promise<Record<string, unknown> | null>((resolve) => {
        const ch = new MessageChannel()
        const timer = setTimeout(() => resolve(null), 2_000)
        ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data as Record<string, unknown>) }
        reg.active!.postMessage({ type: 'RC_SW_STATUS', repair: !!opts.repair }, [ch.port2])
      })
      if (status) {
        out.version = typeof status.version === 'string' ? status.version : null
        out.fallbackCached = typeof status.fallbackCached === 'boolean' ? status.fallbackCached : null
        out.lastCacheError = typeof status.lastCacheError === 'string' ? status.lastCacheError : null
        const cfg = status.config as { api?: string } | undefined
        out.apiConfigured = cfg?.api ?? null
      }
    }
  } catch { /* report what we have */ }
  return out
}
