/* RupChain Service Worker — web push only.
 *
 * ── Why there is no fetch handler here ──────────────────────────────────────
 *
 * A previous revision of this file made navigations network-first with a cache
 * fallback, to replace the browser's ERR_CONNECTION_RESET screen with our own
 * offline page. On desktop that worked. On mobile it took the site down:
 *
 *   1. A navigation to a public route stored its html in a PAGES cache.
 *   2. On a slow link the network lost an 8s race, so the NEXT visit was served
 *      that stored copy — html from whatever build was current when it landed.
 *   3. That html references /_next/static/<buildId>/… chunks. Once a deploy
 *      moves the build id on, the running app and the server disagree, and the
 *      App Router recovers the only way it can: a hard navigation.
 *   4. The hard navigation is a navigation, so step 2 answered it from the same
 *      stale cache. The homepage painted its server-rendered text and every
 *      link led straight back to it.
 *
 * The bug was never one line of that logic; it was the premise. A cached html
 * document is only safe while it is paired with the exact build output it was
 * rendered against, and a service worker that caches documents and hashed
 * chunks in separate stores, with independent eviction, cannot hold that pair
 * together across a deploy. Losing the browser's offline screen is a far
 * smaller cost than serving a stale shell that cannot navigate.
 *
 * So: no DOCUMENT caching. The fetch listener at the bottom of this file only falls back to a
 * static, build-independent /offline.html when a navigation fails outright; it never serves a
 * stored application document. Do not add document or chunk caching without solving the
 * document/chunk pairing problem above first.
 *
 * The registration itself stays (see ensureServiceWorker in lib/installApp.ts)
 * because push subscriptions are bound to it. Keeping it alive is also what
 * lets this file reach devices still running the caching revision.
 */

/* ── Offline fallback (added later; deliberately NOT the old design) ─────────
 *
 * The only thing cached is /offline.html and its icon: a static page that references no build
 * chunks, so it can never pair with the wrong deploy. Application documents, JS chunks, API
 * responses and payment evidence are NEVER cached or replayed. A navigation always goes to the
 * network first with no timeout race; this page is shown only when that request actually FAILS
 * (connection reset, DNS, offline) — i.e. when the browser would otherwise show its error screen.
 * It only helps returning visitors: a first-ever failed load happens before any worker exists.
 */
const OFFLINE_CACHE = 'rc-offline-v2'
const OFFLINE_ASSETS = ['/offline.html', '/brand/icon-192.png']

// ─── Install / activate ──────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(OFFLINE_CACHE)
      await cache.addAll(OFFLINE_ASSETS)
    } catch (e) { /* offline page is best-effort; never block activation */ }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache the previous revision created. Without this, a device
    // that updates to this worker still carries the stale html around — it just
    // stops being served, and sits there occupying the origin's storage quota
    // until the browser evicts it.
    try {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== OFFLINE_CACHE).map((n) => caches.delete(n)))
    } catch (e) { /* storage unavailable; nothing to clean */ }

    // The old worker enabled this to overlap the network with SW startup. With
    // no fetch handler there is nothing to overlap, and leaving it on makes the
    // browser attach a preload header to navigations for no reader.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable() } catch (e) { /* unsupported */ }
    }

    await self.clients.claim()

    // Everyone currently looking at a page served by the old worker is looking
    // at a shell that cannot navigate. Claiming them is not enough, because the
    // document already on screen is the broken one — it has to be re-fetched.
    // This cannot loop: the reload finds this same worker already active, so no
    // second activation happens.
    try {
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) {
        try { client.navigate(client.url) } catch (e) { /* cross-origin or closing */ }
      }
    } catch (e) { /* best-effort */ }
  })())
})

// ─── Navigation fallback ─────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request
  // Top-level page loads only. Never intercept API calls, POSTs, uploads or sub-resources.
  if (req.mode !== 'navigate' || req.method !== 'GET') return
  event.respondWith(navigateWithRetry(req))
})

// A tab left open for hours (or restored/discarded by the browser) re-fetches its document on
// wake-up, often while the network is still reconnecting for a second or two. Retry the SAME
// network request a few times before concluding we are offline, so a momentary blip never
// replaces the app with the offline page. Still network-only: nothing is cached or replayed.
async function navigateWithRetry(req) {
  const delays = [0, 800, 2000, 4000]
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try { return await fetch(req) } catch (e) { /* retry */ }
  }
  return (await caches.match('/offline.html')) || Response.error()
}

// ─── Web push ────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload = {}
  try { payload = event.data.json() } catch (e) { return }

  const { title = 'RupChain', body = '', url = '/', icon = '/brand/icon-192.png' } = payload

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: '/favicon-48x48.png',
      data: { url },
      vibrate: [200, 100, 200],
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})
