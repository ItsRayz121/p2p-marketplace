/* RupChain Service Worker — web push + navigation resilience */

// This worker used to be a deliberate no-op that existed only to satisfy the
// browser's PWA-installability check. That left one gap we kept paying for:
// when a navigation itself failed — a carrier NAT reaping the socket, a TLS
// handshake reset on a weak 4G link — the browser had nothing to fall back on
// and painted its own "This site can't be reached / ERR_CONNECTION_RESET"
// page. None of the retry logic in lib/api.ts can help there, because that
// failure happens before a single byte of application code has run.
//
// So navigations are now network-first with a cache fallback, and the last
// resort is our own offline screen instead of the browser's error page.
//
// Cache layout, and why the names matter:
//   PRECACHE — versioned. Bump VERSION to reship the offline screen.
//   STATIC   — deliberately NOT versioned. It holds content-hashed
//              /_next/static assets. After a deploy those hashes change, but a
//              page served from PAGES is the OLD html referencing the OLD
//              chunks — so purging this on every release would turn the offline
//              fallback into a blank screen. Entries are evicted by count.
//   PAGES    — last-good html for public routes only, never authenticated ones.

const VERSION = 'v1'
const PRECACHE = 'rupchain-precache-' + VERSION
const STATIC = 'rupchain-static'
const PAGES = 'rupchain-pages'
const KEEP = new Set([PRECACHE, STATIC, PAGES])

const OFFLINE_URL = '/offline.html'
const PRECACHE_URLS = [OFFLINE_URL, '/brand/icon-192.png']

// Cap the runtime caches so a long-lived install cannot grow without bound.
const STATIC_MAX = 120
const PAGES_MAX = 30

// Only these prefixes get their html retained. Everything else falls back to
// the offline screen, so no signed-in markup can ever be replayed to a
// different session on a shared device.
const CACHEABLE_PAGES = [
  '/', '/markets', '/gas', '/blog', '/about', '/fees', '/help',
  '/levels', '/leaderboard', '/terms', '/privacy', '/community',
]

// Checked BEFORE the allowlist above, and it wins. Two prefixes overlap: '/gas'
// is public, but '/gas/orders' is a signed-in surface that sits underneath it.
// Without this, a prefix match on '/gas' would both store authenticated html
// AND serve it straight from cache — skipping the middleware redirect that is
// supposed to bounce a signed-out visitor off that route.
//
// Mirror of AUTH_REQUIRED in src/middleware.ts. Keep the two in sync: anything
// gated there must be denied here, or this cache silently becomes a way around
// the gate.
const PRIVATE_PREFIXES = [
  '/dashboard', '/trade', '/wallet', '/profile', '/settings', '/setup-username',
  '/kyc', '/orders', '/payment-methods', '/my-ads', '/create-ad',
  '/notifications', '/referral', '/ctm', '/gas/orders', '/gas/referral',
  '/gas/giveaway', '/admin', '/account', '/messages', '/favorites',
  '/merchant', '/mini-app', '/login', '/register', '/forgot-password',
  '/verify-email', '/confirm-withdrawal',
]

// A navigation that is merely slow should not sit on a white screen forever
// when we already hold a usable copy. We only cut over once there is something
// to show — with nothing cached, waiting on the network still beats showing an
// offline screen to someone whose connection is simply slow.
const SLOW_NAV_MS = 8000

// ─── Install / activate ──────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Deliberately NOT cache.addAll: that is all-or-nothing, so one flaky
    // request for the icon would reject the whole batch and leave the offline
    // page uncached — silently turning this entire worker back into the
    // browser's error screen, which is the one outcome it exists to prevent.
    // Each entry is stored independently; the offline page must never depend on
    // the icon succeeding.
    try {
      const cache = await caches.open(PRECACHE)
      await Promise.all(PRECACHE_URLS.map(async (u) => {
        try {
          const res = await fetch(u, { cache: 'reload' })
          if (res && res.ok) await cache.put(u, res)
        } catch (e) { /* this one entry is unavailable; others still land */ }
      }))
    } catch (e) { /* a failed precache must never block activation */ }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(
      names.map((n) => (n.startsWith('rupchain-') && !KEEP.has(n)) ? caches.delete(n) : undefined)
    )
    // Let the browser fetch the document in parallel with SW startup, so
    // intercepting navigations costs nothing on a healthy connection.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable() } catch (e) { /* unsupported */ }
    }
    await self.clients.claim()
  })())
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function trim(cacheName, max) {
  try {
    const cache = await caches.open(cacheName)
    const keys = await cache.keys()
    // Cache keys come back in insertion order, so the head is the oldest.
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i])
  } catch (e) { /* eviction is best-effort */ }
}

function matchesPrefix(pathname, prefix) {
  return prefix === '/'
    ? pathname === '/'
    : (pathname === prefix || pathname.startsWith(prefix + '/'))
}

function isCacheablePage(pathname) {
  if (PRIVATE_PREFIXES.some((p) => matchesPrefix(pathname, p))) return false
  return CACHEABLE_PAGES.some((p) => matchesPrefix(pathname, p))
}

// Content-hashed build output: the filename changes whenever the bytes do, so a
// cache hit can never be stale and never needs revalidating.
function isHashedAsset(pathname) {
  return pathname.startsWith('/_next/static/')
}

// Static art served from stable URLs. These are NOT content-hashed — /brand/
// icons, /logos/ and the favicons keep the same path across releases — so
// cache-first alone would pin a retired logo on every existing install forever.
// They get stale-while-revalidate instead: instant from cache, refreshed behind
// the user so the next load is current.
function isRevalidatingAsset(pathname) {
  return pathname.startsWith('/brand/')
    || pathname.startsWith('/logos/')
    || /\.(?:woff2?|ttf|otf|png|jpe?g|svg|webp|avif|ico)$/i.test(pathname)
}

async function offlineResponse(request) {
  const url = new URL(request.url)
  const cached = await caches.match(OFFLINE_URL, { cacheName: PRECACHE })
  if (!cached) return Response.error()

  // Hand the offline screen the route the user was actually heading for, so its
  // retry resumes that journey rather than bouncing everyone to the homepage.
  const body = await cached.text()
  const withTarget = body.replace(
    '</head>',
    '<script>window.__OFFLINE_FROM=' + JSON.stringify(url.pathname + url.search) + '</script></head>'
  )
  return new Response(withTarget, {
    // 503 keeps the browser, and any crawler, from treating the fallback as
    // real content for the requested URL.
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  let url
  try { url = new URL(request.url) } catch (e) { return }

  // Cross-origin — above all api.rupchain.com — is left completely alone.
  // Those calls already route through resilientFetch in lib/api.ts, which knows
  // which requests are safe to replay; a cache here could only ever serve a
  // stale balance or a stale order book.
  if (url.origin !== self.location.origin) return

  // Next.js fetches RSC payloads from the same URLs as the documents. Serving a
  // cached html document to one of those would break client-side navigation, so
  // they are passed straight through.
  if (url.searchParams.has('_rsc') || request.headers.get('RSC') === '1') return

  // Same-origin API-shaped routes are never cached.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event, request, url))
    return
  }

  if (isHashedAsset(url.pathname)) {
    event.respondWith(handleHashed(request))
    return
  }

  if (isRevalidatingAsset(url.pathname)) {
    event.respondWith(handleRevalidating(event, request))
  }
})

async function handleNavigation(event, request, url) {
  const cacheable = isCacheablePage(url.pathname)

  const fromNetwork = (async () => {
    const preload = event.preloadResponse ? await event.preloadResponse : null
    const response = preload || await fetch(request)
    // response.redirected is excluded on purpose: replaying a redirected
    // response to a navigation is a SecurityError in Chrome, so storing one
    // would swap a recoverable offline screen for a hard failure.
    if (cacheable && response && response.ok && response.type === 'basic' && !response.redirected) {
      const copy = response.clone()
      event.waitUntil(
        caches.open(PAGES)
          .then((c) => c.put(request, copy))
          .then(() => trim(PAGES, PAGES_MAX))
          .catch(() => { /* best-effort */ })
      )
    }
    return response
  })()

  // Once the race below settles on the cached copy, fromNetwork can still
  // reject with nothing listening — an unhandled rejection inside the worker.
  // This keeps the original promise for awaiting and parks the late failure.
  fromNetwork.catch(() => { /* handled by the race / fallback below */ })

  // ignoreVary: Next serves documents with
  // `Vary: RSC, Next-Router-State-Tree, ...`, and Cache API matching honours
  // Vary. Only plain navigations are ever stored here (RSC requests are
  // filtered out above), so matching on the URL alone is both safe and far
  // less brittle than depending on those headers staying absent.
  const cached = cacheable
    ? await caches.match(request, { cacheName: PAGES, ignoreVary: true })
    : null

  // With a usable copy in hand, stop waiting on a stalled network past
  // SLOW_NAV_MS — the shell renders and its own client-side reads take over.
  if (cached) {
    let timer
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve(cached), SLOW_NAV_MS)
    })
    try {
      const winner = await Promise.race([fromNetwork, slow])
      clearTimeout(timer)
      return winner
    } catch (e) {
      clearTimeout(timer)
      return cached
    }
  }

  try {
    return await fromNetwork
  } catch (e) {
    return offlineResponse(request)
  }
}

// Cache-first, no revalidation. Only ever called for content-hashed URLs, where
// a hit is correct by construction.
//
// This is also what keeps the offline fallback coherent across a deploy: html
// served from PAGES is the OLD document and references the OLD chunk names, and
// they are still sitting here because STATIC is never versioned.
async function handleHashed(request) {
  const cache = await caches.open(STATIC)
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit) return hit
  const response = await fetch(request)
  // Cross-origin was filtered out above, so anything here is same-origin and
  // safe to store. A failed fetch propagates: a missing chunk has no sensible
  // fallback, and the app's own error boundary should see it.
  if (response && response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
    void trim(STATIC, STATIC_MAX)
  }
  return response
}

// Stale-while-revalidate for stable-URL art. Serve the cached copy instantly,
// then refresh it in the background so a replaced logo or favicon reaches the
// user on their next load instead of never.
async function handleRevalidating(event, request) {
  const cache = await caches.open(STATIC)
  const hit = await cache.match(request, { ignoreVary: true })

  const refresh = fetch(request).then(async (response) => {
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response.clone())
      void trim(STATIC, STATIC_MAX)
    }
    return response
  })

  if (hit) {
    // Keep the worker alive for the background refresh, and absorb its failure:
    // being offline is the normal case here and must not surface as an
    // unhandled rejection.
    event.waitUntil(refresh.catch(() => { /* offline — the hit already served */ }))
    return hit
  }

  return refresh
}

// ─── Web push (unchanged behaviour) ──────────────────────────────────────────

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
