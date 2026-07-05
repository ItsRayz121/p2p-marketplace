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

// Key under which the launch-hash initData is mirrored into sessionStorage.
// Shared by the detect script and the TS helpers below — keep them in sync.
const TG_INIT_DATA_STORAGE_KEY = 'tg_init_data'
// Telegram's `startapp` value arrives as the hash param `tgWebAppStartParam`.
// Like initData it only appears on the FIRST open, so we mirror it too.
const TG_START_PARAM_STORAGE_KEY = 'tg_start_param'

// Synchronous inline script — injected as the first <body> child in layout.tsx
// (same pattern as THEME_SCRIPT) so it runs before React hydration and before
// telegram-web-app.js. Captures the launch-hash signals into window globals AND
// mirrors initData into sessionStorage.
//
// Why sessionStorage: Telegram only appends "#tgWebAppData=..." on the FIRST
// open. Our own client-side redirect ("/" → "/mini-app") drops the hash, and a
// hard reload (the error screen's "Try again" calls location.reload()) lands on
// a hash-less URL — so without a durable copy the launch data is lost and auth
// fails for the rest of the session. sessionStorage is per-tab and cleared when
// the WebView closes, so a stale launch can't outlive the Telegram session.
export const TELEGRAM_DETECT_SCRIPT = `(function(){
  try {
    var h = location.hash || '';
    var raw = h.charAt(0) === '#' ? h.slice(1) : h;
    var p = new URLSearchParams(raw);
    var initData = p.get('tgWebAppData') || '';
    if (initData) {
      try { sessionStorage.setItem('${TG_INIT_DATA_STORAGE_KEY}', initData); } catch (e) {}
    } else {
      try { initData = sessionStorage.getItem('${TG_INIT_DATA_STORAGE_KEY}') || ''; } catch (e) {}
    }
    var startParam = p.get('tgWebAppStartParam') || '';
    if (startParam) {
      try { sessionStorage.setItem('${TG_START_PARAM_STORAGE_KEY}', startParam); } catch (e) {}
    }
    window.__TG_INIT_DATA__ = initData;
    window.__IS_TELEGRAM__ = !!initData;
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
      : (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com')
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
  // Durable mirror — survives the hash-dropping redirect and hard reloads.
  try {
    const stored = sessionStorage.getItem(TG_INIT_DATA_STORAGE_KEY)
    if (stored) return stored
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
  try {
    if (sessionStorage.getItem(TG_INIT_DATA_STORAGE_KEY)) return true
  } catch { /* ignore */ }
  return !!window.Telegram?.WebApp?.initData
}

/** The optional SDK object — may be undefined if the script hasn't loaded (or ever loads). */
export function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined
  return window.Telegram?.WebApp
}

/**
 * The Mini App start parameter (Telegram's `startapp` value). Read from the live
 * launch hash first, then the durable sessionStorage mirror, then the SDK. Empty
 * string when absent. Used to deep-link a freshly-launched Mini App to a shared
 * listing (see parseStartParamToPath).
 */
export function getStartParam(): string {
  if (typeof window === 'undefined') return ''
  try {
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    const fromHash = new URLSearchParams(raw).get('tgWebAppStartParam')
    if (fromHash) return fromHash
  } catch { /* ignore */ }
  try {
    const stored = sessionStorage.getItem(TG_START_PARAM_STORAGE_KEY)
    if (stored) return stored
  } catch { /* ignore */ }
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param ?? ''
}

/**
 * Map a Mini App start parameter to an internal app path, or null if it isn't a
 * recognised deep link. Listing share links encode `L_usdt_<id>` / `L_ctm_<id>`
 * (start params allow only [A-Za-z0-9_-], max 64). Referral codes (`ref_…`) are
 * handled by the bot, not here.
 */
export function parseStartParamToPath(param: string): string | null {
  if (!param) return null
  const m = param.match(/^L_(usdt|ctm)_([A-Za-z0-9]+)$/)
  if (!m) return null
  const [, kind, id] = m
  return kind === 'usdt' ? `/marketplace/listings/${id}` : `/ctm/listings/${id}`
}

/**
 * Build shareable links for a listing. `web` is the canonical https URL (works
 * everywhere + rich preview); `telegram` opens the Mini App straight to the
 * listing via startapp (null when the bot username env is unset).
 */
export function buildListingShareLinks(
  kind: 'usdt' | 'ctm',
  id: string,
  refCode?: string | null,
): { web: string; telegram: string | null } {
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.replace(/^@/, '')
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com')
  const path = kind === 'usdt' ? `/marketplace/listings/${id}` : `/ctm/listings/${id}`
  // A shared trade link doubles as a referral link: a brand-new visitor who opens
  // it and signs up is attributed to the sharer (ReferralCapture stashes ?ref for
  // the register flow; middleware preserves it through the login gate on /ctm).
  const ref = refCode ? `?ref=${encodeURIComponent(refCode)}` : ''
  return {
    web: `${origin}${path}${ref}`,
    // Telegram in-app deep link keeps the existing referral mechanism (bot
    // ref_<code> link); listing start params carry no ref to avoid conflicting
    // with the anchored backend parser.
    telegram: bot ? `https://t.me/${bot}?startapp=L_${kind}_${id}` : null,
  }
}

/** Open a link the Telegram-native way when inside the Mini App, else a normal tab. */
export function openTelegramLink(url: string): void {
  try {
    const wa = getWebApp() as (TelegramWebApp & { openTelegramLink?: (u: string) => void }) | undefined
    if (wa?.openTelegramLink) { wa.openTelegramLink(url); return }
  } catch { /* fall through */ }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
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
