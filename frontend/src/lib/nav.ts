// Safe "back" navigation helper.
//
// Problem: `router.back()` is just `window.history.back()`. When a user lands
// directly on a page (a shared link, a push/Telegram deep-link, a fresh tab)
// there is no in-app history to go back to, so `back()` either does nothing or
// — inside the Telegram Mini App — exits/closes the app. There is no built-in
// way to ask Next's App Router "will back() stay inside the app?".
//
// Fix: track whether the user has navigated WITHIN the app at least once during
// this page-load. The counter is module-level, so it resets to 0 on every full
// page load / cold open (exactly the case where back() is unsafe). Once they've
// navigated in-app, back() is safe and preserves the natural stack.

import type { useRouter } from 'next/navigation'

type AppRouter = ReturnType<typeof useRouter>

let inAppNavCount = 0

/** Call on each in-app route change (after the initial mount). */
export function noteInAppNavigation(): void {
  inAppNavCount += 1
}

/** True once the user has navigated within the app this page-load. */
export function canGoBackInApp(): boolean {
  return inAppNavCount > 0
}

/**
 * Go back if there's in-app history, otherwise navigate to a safe fallback so
 * the user is never stranded / the Mini App is never closed unexpectedly.
 */
export function goBackSafe(router: AppRouter, fallback = '/dashboard'): void {
  if (canGoBackInApp()) {
    try { router.back(); return } catch { /* fall through to fallback */ }
  }
  router.push(fallback)
}
