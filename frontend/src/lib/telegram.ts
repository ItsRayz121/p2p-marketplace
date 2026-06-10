// Telegram Mini App — detection + initData access + optional SDK polish.
//
// THE GOLDEN RULE (both detection AND auth derive from the launch hash, never
// the User-Agent and never the SDK being loaded):
//   Telegram appends "#tgWebAppData=...&tgWebAppVersion=...&tgWebAppPlatform=..."
//   to the URL on EVERY open, before any script runs. telegram-web-app.js is
//   async and often fails on slow networks / VPN / Android WebView, so we read
//   initData straight from the hash and treat the SDK as optional polish only.

// ── Window globals set synchronously by TELEGRAM_DETECT_SCRIPT (see below) ──
declare global {
  interface Window {
    __IS_TELEGRAM__?: boolean
    __TG_INIT_DATA__?: string
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

// Minimal shape of the bits of the SDK we use for polish. Everything is
// optional — callers must no-op if the SDK never loads.
export interface TelegramWebApp {
  initData?: string
  initDataUnsafe?: { start_param?: string; user?: { id: number } }
  version?: string
  platform?: string
  colorScheme?: 'light' | 'dark'
  themeParams?: Record<string, string>
  ready?: () => void
  expand?: () => void
  close?: () => void
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void }
  HapticFeedback?: { impactOccurred: (s: string) => void; notificationOccurred: (t: string) => void; selectionChanged: () => void }
  onEvent?: (event: string, cb: () => void) => void
  setHeaderColor?: (color: string) => void
  setBackgroundColor?: (color: string) => void
}

// Synchronous inline script — injected as the first <body> child in layout.tsx
// (same pattern as THEME_SCRIPT) so it runs before React hydration and before
// telegram-web-app.js. Captures the launch-hash signals into window globals.
export const TELEGRAM_DETECT_SCRIPT = `(function(){
  try {
    var h = location.hash || '';
    window.__IS_TELEGRAM__ = h.indexOf('tgWebAppData') !== -1;
    var raw = h.charAt(0) === '#' ? h.slice(1) : h;
    var p = new URLSearchParams(raw);
    window.__TG_INIT_DATA__ = p.get('tgWebAppData') || '';
  } catch (e) {}
})();`

/**
 * Build the two canonical referral links for a code. The Telegram deep link is
 * primary (one-tap auto-auth for the largest audience); the web link is the
 * fallback for non-Telegram / social sharing. Both carry the SAME code.
 *   • Telegram: https://t.me/<bot>?start=ref_<code>
 *   • Web:      <origin>/r/<code>
 * The Telegram link is null when NEXT_PUBLIC_TELEGRAM_BOT_USERNAME is unset.
 */
export function buildReferralLinks(code: string): { telegram: string | null; web: string } {
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.replace(/^@/, '')
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.pk')
  return {
    telegram: bot ? `https://t.me/${bot}?start=ref_${code}` : null,
    web: `${origin}/r/${code}`,
  }
}

/** The raw initData string captured from the launch hash (with a live-hash fallback). */
export function getInitData(): string {
  if (typeof window === 'undefined') return ''
  if (window.__TG_INIT_DATA__) return window.__TG_INIT_DATA__
  try {
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const fromHash = new URLSearchParams(raw).get('tgWebAppData')
    if (fromHash) return fromHash
  } catch { /* ignore */ }
  // SDK is the LAST resort, never the gate.
  return window.Telegram?.WebApp?.initData ?? ''
}

/**
 * True when we're running inside the Telegram Mini App WebView. Order of trust:
 * the synchronous flag → a live hash containing tgWebAppData → SDK initData.
 * Never sniffs the User-Agent (Telegram's Android WebView omits "Telegram").
 */
export function isTelegramMiniApp(): boolean {
  if (typeof window === 'undefined') return false
  if (window.__IS_TELEGRAM__) return true
  try {
    if (window.location.hash.includes('tgWebAppData')) return true
  } catch { /* ignore */ }
  return !!window.Telegram?.WebApp?.initData
}

/** The optional SDK object — may be undefined if the script hasn't loaded (or ever loads). */
export function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined
  return window.Telegram?.WebApp
}

// ── Optional polish helpers — every one is a no-op when not in Telegram / no
// SDK. Never call these in a way that gates core functionality. ──

/** Light haptic tick for selection-style actions (copy, toggle). Safe everywhere. */
export function hapticSelection(): void {
  try { getWebApp()?.HapticFeedback?.selectionChanged() } catch { /* noop */ }
}

/** Haptic impact for confirmations / primary actions. */
export function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'medium'): void {
  try { getWebApp()?.HapticFeedback?.impactOccurred(style) } catch { /* noop */ }
}

/** Haptic for success/error/warning outcomes. */
export function hapticNotify(type: 'success' | 'error' | 'warning'): void {
  try { getWebApp()?.HapticFeedback?.notificationOccurred(type) } catch { /* noop */ }
}

/**
 * Follow Telegram's color scheme and chrome colors for a native feel. Only
 * applies dark/light from Telegram when the user hasn't explicitly chosen a
 * theme in-app (rupchain-theme), so an explicit preference always wins.
 */
export function applyTelegramChrome(wa: TelegramWebApp | undefined): void {
  if (!wa || typeof document === 'undefined') return
  try {
    const stored = localStorage.getItem('rupchain-theme')
    if (!stored && wa.colorScheme) {
      document.documentElement.classList.toggle('dark', wa.colorScheme === 'dark')
    }
    // Match Telegram's header/background to the app surface so there's no seam.
    const isDark = document.documentElement.classList.contains('dark')
    wa.setHeaderColor?.(isDark ? '#0D1B2A' : '#FFFFFF')
    wa.setBackgroundColor?.(isDark ? '#0D1B2A' : '#FFFFFF')
  } catch { /* noop */ }
}

// Lazily inject telegram-web-app.js for optional polish (theme/BackButton/
// haptics). Resolves with the SDK object if it loads within `timeoutMs`, else
// undefined — callers MUST tolerate undefined. Never used to gate auth.
let sdkLoadPromise: Promise<TelegramWebApp | undefined> | null = null
export function loadTelegramSdk(timeoutMs = 3500): Promise<TelegramWebApp | undefined> {
  if (typeof window === 'undefined') return Promise.resolve(undefined)
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp)
  if (sdkLoadPromise) return sdkLoadPromise

  sdkLoadPromise = new Promise<TelegramWebApp | undefined>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(window.Telegram?.WebApp)
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-telegram-sdk]')
    if (!existing) {
      const s = document.createElement('script')
      s.src = 'https://telegram.org/js/telegram-web-app.js'
      s.async = true
      s.setAttribute('data-telegram-sdk', '1')
      s.onload = finish
      s.onerror = finish // resolve undefined — polish degrades gracefully
      document.head.appendChild(s)
    }
    // Poll briefly in case the script is cached / already executing, then give up.
    const start = Date.now()
    const tick = () => {
      if (window.Telegram?.WebApp) return finish()
      if (Date.now() - start > timeoutMs) return finish()
      setTimeout(tick, 100)
    }
    tick()
  })
  return sdkLoadPromise
}
