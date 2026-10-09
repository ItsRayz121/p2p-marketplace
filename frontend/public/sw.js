/* RupChain Service Worker — web push + a static connection-problem page.
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
 * (connection reset, ERR_NETWORK_CHANGED, DNS, offline) or the edge answers 502/503/504 —
 * i.e. when the browser would otherwise show its own error screen.
 *
 * Limits (browser-owned screens we cannot replace):
 *   - a first-ever visit, before this worker has installed and taken control;
 *   - a reload that bypasses the worker (e.g. Shift+reload, or the browser's own "Reload" on
 *     its error page after the worker gave up);
 *   - POST navigations (form submissions) — deliberately not intercepted;
 *   - in-app WebViews that do not run service workers.
 */
const SW_VERSION = '2026-10-09.1'
const OFFLINE_CACHE = 'rc-offline-v3'
const OFFLINE_URL = '/offline.html'
const ICON_URL = '/brand/icon-192.png'
// Page-supplied settings (currently the API origin, for the recovery check). Stored as a tiny
// JSON entry in the offline cache so it survives the worker being stopped between events.
const CONFIG_URL = '/__rc-sw-config'

// Last cache failure, for diagnostics. Not persisted.
let lastCacheError = null

/** Fetch the offline page fresh (bypassing HTTP caches) and store it. Throws on failure. */
async function cacheOfflinePage() {
  const cache = await caches.open(OFFLINE_CACHE)
  const res = await fetch(new Request(OFFLINE_URL, { cache: 'reload' }))
  if (!res.ok) throw new Error('offline page HTTP ' + res.status)
  await cache.put(OFFLINE_URL, res)
}

/** The essential page first, retried once; the icon separately and best-effort. */
async function precache() {
  let ok = false
  for (let i = 0; i < 2 && !ok; i++) {
    try { await cacheOfflinePage(); ok = true; lastCacheError = null }
    catch (e) { lastCacheError = String((e && e.message) || e) }
  }
  try {
    const cache = await caches.open(OFFLINE_CACHE)
    await cache.add(new Request(ICON_URL, { cache: 'reload' }))
  } catch (e) { /* the page inlines its logo; the icon is only for push notifications */ }
  return ok
}

async function hasOfflinePage() {
  try { return !!(await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE })) } catch (e) { return false }
}

// ─── Install / activate ──────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Never block installation on the cache: a worker without the cached page still has the
    // built-in fallback below, and push must keep working.
    try { await precache() } catch (e) { /* storage unavailable */ }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache the previous revisions created. Only the very old document-caching
    // revision left non-"rc-offline-" caches behind; remember whether we found one.
    let hadLegacyPageCache = false
    try {
      const names = await caches.keys()
      const stale = names.filter((n) => n !== OFFLINE_CACHE)
      hadLegacyPageCache = stale.some((n) => !/^rc-offline-/.test(n))
      await Promise.all(stale.map((n) => caches.delete(n)))
    } catch (e) { /* storage unavailable; nothing to clean */ }

    // Install may have run while the connection was down. Try once more now.
    if (!(await hasOfflinePage())) { try { await precache() } catch (e) { /* retried on next navigation */ } }

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable() } catch (e) { /* unsupported */ }
    }

    await self.clients.claim()

    // Pages served by the old document-caching worker are shells that cannot navigate, so
    // those (and only those) have to be re-fetched. An ordinary update must NOT reload open
    // tabs: that would throw away whatever the user was typing.
    if (hadLegacyPageCache) {
      try {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) {
          try { client.navigate(client.url) } catch (e) { /* cross-origin or closing */ }
        }
      } catch (e) { /* best-effort */ }
    }

    await broadcast({ type: 'RC_SW_ACTIVATED', version: SW_VERSION })
  })())
})

async function broadcast(msg) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of clients) { try { c.postMessage(msg) } catch (e) { /* closing */ } }
  } catch (e) { /* best-effort */ }
}

// ─── Diagnostics + config from the page ──────────────────────────────────────

async function readConfig() {
  try {
    const r = await caches.match(CONFIG_URL, { cacheName: OFFLINE_CACHE })
    return r ? await r.json() : {}
  } catch (e) { return {} }
}

self.addEventListener('message', (event) => {
  const data = event.data || {}
  const reply = (msg) => {
    const port = event.ports && event.ports[0]
    if (port) port.postMessage(msg)
    else if (event.source) event.source.postMessage(msg)
  }
  if (data.type === 'RC_SW_STATUS') {
    event.waitUntil((async () => {
      let fallbackCached = await hasOfflinePage()
      // A diagnostics check is also the moment to repair an evicted fallback page.
      if (!fallbackCached && data.repair) { try { fallbackCached = await precache() } catch (e) { /* offline */ } }
      reply({
        type: 'RC_SW_STATUS',
        version: SW_VERSION,
        cacheName: OFFLINE_CACHE,
        fallbackCached,
        lastCacheError,
        config: await readConfig(),
      })
    })())
  } else if (data.type === 'RC_SW_CONFIG' && typeof data.api === 'string') {
    // Only accept an https origin; anything else clears it.
    let api = ''
    try { if (data.api) { const u = new URL(data.api); if (u.protocol === 'https:') api = u.origin } } catch (e) { api = '' }
    event.waitUntil((async () => {
      try {
        const current = await readConfig()
        if (current.api === api) return
        const cache = await caches.open(OFFLINE_CACHE)
        await cache.put(CONFIG_URL, new Response(JSON.stringify({ api }), { headers: { 'Content-Type': 'application/json' } }))
      } catch (e) { /* storage unavailable */ }
    })())
  }
})

// ─── Navigation fallback ─────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request
  // Top-level page loads only. Never intercept API calls, POSTs, uploads or sub-resources.
  if (req.mode !== 'navigate' || req.method !== 'GET') return
  event.respondWith(navigateWithRetry(req, event))
})

// Gateway answers from the edge mean "RupChain's server is not answering", not "your page".
// A plain 500 is left alone: that is the app's own error page.
const GATEWAY_STATUSES = new Set([502, 503, 504])

// A tab left open for hours (or restored/discarded by the browser) re-fetches its document on
// wake-up, often while the network is still reconnecting — and a Wi-Fi/mobile switch aborts an
// in-flight load with ERR_NETWORK_CHANGED. Retry the SAME GET a few times with backoff before
// concluding the network is down. Still network-only: nothing is cached or replayed.
async function navigateWithRetry(req, event) {
  const delays = [0, 600, 1500, 3000]
  let lastStatus = 0
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      const res = await fetch(req)
      if (!GATEWAY_STATUSES.has(res.status)) {
        // The network works right now: make sure the fallback page is in place for next time.
        event.waitUntil(hasOfflinePage().then((ok) => (ok ? null : precache())).catch(() => {}))
        return res
      }
      lastStatus = res.status
    } catch (e) { lastStatus = 0 /* connection failure: retry */ }
  }
  return fallbackResponse(lastStatus ? 'server' : 'network')
}

async function fallbackResponse(reason) {
  const config = await readConfig()
  const fill = (html) => html.replace(
    '<body data-reason="network" data-sw="" data-api="">',
    '<body data-reason="' + reason + '" data-sw="' + SW_VERSION + '" data-api="' + escapeAttr(config.api || '') + '">',
  )
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-RupChain-Fallback': 'inline' }
  try {
    const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE })
    if (cached) {
      headers['X-RupChain-Fallback'] = 'cached'
      return new Response(fill(await cached.text()), { status: 503, statusText: 'Service Unavailable', headers })
    }
  } catch (e) { /* Cache Storage failed: fall through to the built-in page */ }
  return new Response(fill(INLINE_FALLBACK), { status: 503, statusText: 'Service Unavailable', headers })
}

function escapeAttr(s) {
  return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]))
}

// Minimal self-contained page for when /offline.html was never cached or has been evicted.
// Same wording as offline.html; a lettermark instead of the logo image; manual retry only, so it
// can never reload in a loop.
const INLINE_FALLBACK = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
  '<title>RupChain — connection problem</title><style>' +
  ':root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;' +
  'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}' +
  '@media(prefers-color-scheme:dark){body{background:#0D1B2A;color:#f1f5f9}p{color:#cbd5e1!important}}' +
  'main{max-width:22rem;text-align:center}.mark{width:56px;height:56px;margin:0 auto;border-radius:22%;background:#0D1B2A;color:#38bdf8;' +
  'font:700 30px/56px system-ui,Arial,sans-serif;box-shadow:0 0 0 1px rgba(255,255,255,.25)}' +
  'h1{font-size:1.15rem;margin:1.1rem 0 .4rem}p{margin:0 0 1.25rem;font-size:.9rem;line-height:1.5;color:#475569}' +
  'button{font:inherit;font-weight:600;background:#2563eb;color:#fff;border:0;border-radius:.6rem;padding:.7rem 1.6rem;min-height:44px}' +
  '#s{min-height:1.2rem;font-size:.8rem;color:#64748b;margin-top:.9rem}</style></head>' +
  '<body data-reason="network" data-sw="" data-api=""><main><div class="mark" aria-hidden="true">R</div>' +
  '<h1 id="t">We couldn’t connect to RupChain just now.</h1><p>Please try again in a moment.</p>' +
  '<button type="button" id="b">Try again</button><p id="s" role="status" aria-live="polite"></p></main><script>' +
  '(function(){var B=document.body,b=document.getElementById("b"),s=document.getElementById("s"),run=false;' +
  'if(B.getAttribute("data-reason")==="server")document.getElementById("t").textContent="RupChain is having trouble right now.";' +
  'function go(){if(run)return;run=true;b.disabled=true;s.textContent="Reconnecting…";' +
  'fetch(location.href,{cache:"no-store",credentials:"same-origin"}).then(function(r){if(r.status<500){location.reload();return}throw 0})' +
  '.catch(function(){run=false;b.disabled=false;s.textContent="Still can’t connect. Please try again in a moment."})}' +
  'b.addEventListener("click",go)})();' +
  '</' + 'script></body></html>'

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
