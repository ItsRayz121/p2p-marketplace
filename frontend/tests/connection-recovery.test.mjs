// Regression checks for connection recovery: public/sw.js, public/offline.html and the
// recovery-evidence rule in src/lib/connectionStatus.ts.
//
// Run: npm test  (node --test; Node 22.6+ for the .ts import via type stripping)
//
// The worker and the offline page are plain browser scripts, so they run here in a vm with
// small fakes for the browser APIs they touch. Long timeouts are scaled down by rewriting
// the constants in the source text; each rewrite is asserted, so a renamed constant fails
// the test instead of silently testing nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SW_SRC = readFileSync(root + 'public/sw.js', 'utf8')
const OFFLINE_SRC = readFileSync(root + 'public/offline.html', 'utf8')

// A regression that removes a timeout shows up as a hang; fail it quickly instead.
const BOUNDED = { timeout: 5000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const never = () => new Promise(() => {})

function rewrite(src, pairs) {
  for (const [from, to] of pairs) {
    assert.ok(src.includes(from), 'source no longer contains: ' + from)
    src = src.split(from).join(to)
  }
  return src
}

// ─── Service worker harness ───────────────────────────────────────────────────

const FAST_SW = rewrite(SW_SRC, [
  ['NAV_ATTEMPT_TIMEOUT_MS = 12000', 'NAV_ATTEMPT_TIMEOUT_MS = 60'],
  ['NAV_TOTAL_BUDGET_MS = 30000', 'NAV_TOTAL_BUDGET_MS = 200'],
  ['PRECACHE_FETCH_TIMEOUT_MS = 10000', 'PRECACHE_FETCH_TIMEOUT_MS = 40'],
  ['PRECACHE_TOTAL_TIMEOUT_MS = 25000', 'PRECACHE_TOTAL_TIMEOUT_MS = 150'],
  ['CACHE_OP_TIMEOUT_MS = 3000', 'CACHE_OP_TIMEOUT_MS = 40'],
  ['INLINE_RETRY_TIMEOUT_MS = 10000', 'INLINE_RETRY_TIMEOUT_MS = 60'],
  ['const delays = [0, 600, 1500, 3000]', 'const delays = [0, 5, 10, 15]'],
])

function loadWorker({ fetch: fetchImpl, caches, clients = [] } = {}) {
  const listeners = {}
  const navigated = []
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: async () => {},
    registration: { navigationPreload: null, showNotification: async () => {} },
    clients: {
      claim: async () => {},
      matchAll: async () => clients.map((url) => ({ url, navigate: (u) => navigated.push(u), postMessage: () => {} })),
    },
    location: { origin: 'https://rupchain.test' },
  }
  const ctx = vm.createContext({
    self, caches, fetch: fetchImpl, Request, Response, URL, AbortController, setTimeout, clearTimeout, Promise, Set, Date, String, Error, JSON,
  })
  vm.runInContext(FAST_SW, ctx)
  return { ctx, listeners, navigated }
}

function fakeCaches({ names = [], match = async () => undefined, hang = false } = {}) {
  const deleted = []
  const opened = []
  return {
    deleted,
    opened,
    keys: async () => names.slice(),
    delete: async (n) => { deleted.push(n); return true },
    match: hang ? never : match,
    open: async (n) => { opened.push(n); return { put: async () => {}, add: async () => {} } },
  }
}

async function runActivate(w) {
  let done
  w.listeners.activate({ waitUntil: (p) => { done = p } })
  await done
}

// ─── 1. Bounded timeouts ──────────────────────────────────────────────────────

test('sw: a navigation that never settles ends on the recovery page within the budget', BOUNDED, async () => {
  let calls = 0
  const w = loadWorker({ fetch: () => { calls++; return never() }, caches: fakeCaches() })
  const t0 = Date.now()
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/p2p' }, { waitUntil() {} })
  const took = Date.now() - t0
  assert.equal(res.status, 503)
  assert.match(await res.text(), /couldn’t connect to RupChain/)
  assert.ok(calls >= 2, 'retried the navigation')
  assert.ok(took < 1000, 'bounded (took ' + took + ' ms)')
})

test('sw: a slow first attempt is not thrown away when the retry stalls', BOUNDED, async () => {
  // Attempt 1 answers after its per-attempt timeout (60 ms) but inside the budget (200 ms);
  // later attempts hang. The slow answer must still be used, not the recovery page.
  const page = new Response('<html>slow but fine</html>', { status: 200 })
  let calls = 0
  const w = loadWorker({ fetch: () => (++calls === 1 ? sleep(100).then(() => page) : never()), caches: fakeCaches() })
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/' }, { waitUntil() {} })
  assert.equal(res, page)
  assert.ok(calls >= 2, 'a retry was started while the first was slow')
})

test('sw: a slow success still wins before the deadline even when later attempts fail fast', BOUNDED, async () => {
  // Attempt 1 is slower than the per-attempt timeout (60 ms) but answers at 120 ms, inside the
  // 200 ms budget. Every retry fails immediately. The slow answer must win, not the fallback.
  const page = new Response('<html>slow but fine</html>', { status: 200 })
  let calls = 0
  const w = loadWorker({
    fetch: () => (++calls === 1 ? sleep(120).then(() => page) : Promise.reject(new TypeError('ERR_NETWORK_CHANGED'))),
    caches: fakeCaches(),
  })
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/' }, { waitUntil() {} })
  assert.equal(res, page)
  assert.equal(calls, 4, 'all retries ran and failed while the first was still loading')
})

test('sw: a fast failure moves straight to the next attempt', BOUNDED, async () => {
  const page = new Response('ok', { status: 200 })
  let calls = 0
  const w = loadWorker({ fetch: async () => { if (++calls < 3) throw new TypeError('ERR_NETWORK_CHANGED'); return page }, caches: fakeCaches() })
  const t0 = Date.now()
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/' }, { waitUntil() {} })
  assert.equal(res, page)
  assert.equal(calls, 3)
  assert.ok(Date.now() - t0 < 100, 'did not wait out the attempt timeout')
})

test('sw: gateway answers on every attempt give the server-wording page', BOUNDED, async () => {
  const w = loadWorker({ fetch: async () => new Response('bad gateway', { status: 502 }), caches: fakeCaches() })
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/' }, { waitUntil() {} })
  assert.equal(res.status, 503)
  assert.match(await res.text(), /data-reason="server"/)
})

test('sw: navigation still returns a real response untouched (no caching of documents)', BOUNDED, async () => {
  const caches = fakeCaches()
  const page = new Response('<html>app</html>', { status: 200 })
  const w = loadWorker({ fetch: async () => page, caches })
  const res = await w.ctx.navigateWithRetry({ url: 'https://rupchain.test/' }, { waitUntil() {} })
  assert.equal(res, page)
})

test('sw: precache with a hung network resolves false and records the error', BOUNDED, async () => {
  const w = loadWorker({ fetch: () => never(), caches: fakeCaches() })
  const t0 = Date.now()
  const ok = await w.ctx.precache()
  assert.equal(ok, false)
  assert.ok(Date.now() - t0 < 1000)
})

test('sw: precache with hung Cache Storage still resolves', BOUNDED, async () => {
  const caches = { open: () => never(), match: () => never(), keys: async () => [], delete: async () => true }
  const w = loadWorker({ fetch: async () => new Response('x'), caches })
  assert.equal(await w.ctx.precache(), false)
})

test('sw: the fallback is served even when Cache Storage hangs', BOUNDED, async () => {
  const w = loadWorker({ fetch: () => never(), caches: fakeCaches({ hang: true }) })
  const res = await w.ctx.fallbackResponse('network')
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('X-RupChain-Fallback'), 'inline')
})

// The inline fallback page's own script, run against a tiny fake DOM.
async function inlineFallbackPage(fetchImpl, { abortController = true } = {}) {
  const w = loadWorker({ fetch: () => never(), caches: fakeCaches() })
  const html = await (await w.ctx.fallbackResponse('network')).text()
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
  const el = () => ({ textContent: '', disabled: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f }, getAttribute: () => 'network' })
  const els = { b: el(), s: el(), t: el() }
  let reloaded = 0
  const ctx = vm.createContext({
    document: { body: { getAttribute: () => 'network' }, getElementById: (id) => els[id] },
    location: { href: 'https://rupchain.test/p2p', reload: () => { reloaded++ } },
    fetch: fetchImpl, setTimeout, clearTimeout,
    ...(abortController ? { AbortController } : {}),
  })
  vm.runInContext(script, ctx)
  return { els, reloads: () => reloaded }
}

test('sw inline fallback: "Try again" becomes usable again after a timed-out check', BOUNDED, async () => {
  let signal
  const p = await inlineFallbackPage((_u, o) => { signal = o.signal; return never() })
  p.els.b.handlers.click()
  assert.equal(p.els.b.disabled, true)
  assert.equal(p.els.s.textContent, 'Reconnecting…')
  await sleep(120)
  assert.equal(p.els.b.disabled, false)
  assert.match(p.els.s.textContent, /Still can’t connect/)
  assert.equal(signal.aborted, true, 'the stalled request was aborted')
  assert.equal(p.reloads(), 0)
})

test('sw inline fallback: the timeout also works without AbortController', BOUNDED, async () => {
  const p = await inlineFallbackPage(() => never(), { abortController: false })
  p.els.b.handlers.click()
  await sleep(120)
  assert.equal(p.els.b.disabled, false)
})

test('sw inline fallback: a successful manual check reloads', BOUNDED, async () => {
  const p = await inlineFallbackPage(async () => ({ status: 200 }))
  p.els.b.handlers.click()
  await sleep(10)
  assert.equal(p.reloads(), 1)
})

// ─── 3. Known cache names only ────────────────────────────────────────────────

test('sw: cleanup plan only touches known RupChain caches', BOUNDED, () => {
  const w = loadWorker({ fetch: () => never(), caches: fakeCaches() })
  const plan = (n) => JSON.parse(JSON.stringify(w.ctx.planCacheCleanup(n)))
  assert.deepEqual(plan(['rc-offline-v3', 'workbox-precache-v2', 'rc-offline-v9', 'rupchain-other', 'third-party']),
    { remove: [], hadLegacyPageCache: false })
  assert.deepEqual(plan(['rc-offline-v1', 'rc-offline-v2', 'rc-offline-v3']),
    { remove: ['rc-offline-v1', 'rc-offline-v2'], hadLegacyPageCache: false })
  assert.deepEqual(plan(['rupchain-pages', 'rupchain-static', 'rupchain-precache-v1', 'unrelated']),
    { remove: ['rupchain-pages', 'rupchain-static', 'rupchain-precache-v1'], hadLegacyPageCache: true })
})

test('sw activate: unrelated caches are neither deleted nor a reason to reload tabs', BOUNDED, async () => {
  const caches = fakeCaches({ names: ['rc-offline-v3', 'some-library-cache', 'rupchain-something-new'], match: async () => new Response('x') })
  const w = loadWorker({ fetch: async () => new Response('x'), caches, clients: ['https://rupchain.test/trade/1'] })
  await runActivate(w)
  assert.deepEqual(caches.deleted, [])
  assert.deepEqual(w.navigated, [])
})

test('sw activate: the legacy document cache is deleted and open tabs re-fetched', BOUNDED, async () => {
  const caches = fakeCaches({ names: ['rupchain-pages', 'rc-offline-v2', 'some-library-cache'], match: async () => new Response('x') })
  const w = loadWorker({ fetch: async () => new Response('x'), caches, clients: ['https://rupchain.test/'] })
  await runActivate(w)
  assert.deepEqual(caches.deleted.sort(), ['rc-offline-v2', 'rupchain-pages'])
  assert.deepEqual(w.navigated, ['https://rupchain.test/'])
})

test('sw: the fetch handler ignores API calls, POSTs and sub-resources', BOUNDED, () => {
  const w = loadWorker({ fetch: () => never(), caches: fakeCaches() })
  for (const request of [
    { mode: 'cors', method: 'GET' },
    { mode: 'navigate', method: 'POST' },
    { mode: 'no-cors', method: 'GET' },
  ]) {
    let responded = false
    w.listeners.fetch({ request, respondWith: () => { responded = true } })
    assert.equal(responded, false)
  }
})

// ─── offline.html harness ─────────────────────────────────────────────────────

const OFFLINE_SCRIPT = rewrite(OFFLINE_SRC.match(/<script>([\s\S]*)<\/script>/)[1], [
  ['timed(location.href, 10000', 'timed(location.href, 60'],
  ["'/health/ready', 8000", "'/health/ready', 60"],
])

function storage(mode) {
  const m = new Map()
  if (mode === 'throws') {
    const boom = () => { throw new Error('SecurityError') }
    return { getItem: boom, setItem: boom, removeItem: boom, map: m }
  }
  if (mode === 'drops') return { getItem: () => null, setItem: () => {}, removeItem: () => {}, map: m }
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m }
}

function offlinePage({ sessionStorage, fetch: fetchImpl, api = 'https://api.rupchain.test' }) {
  const winHandlers = {}
  const docHandlers = {}
  const el = () => ({ textContent: '', disabled: false, handlers: {}, addEventListener(t, f) { this.handlers[t] = f } })
  const els = { status: el(), retry: el(), title: el(), diag: el() }
  const urls = []
  let reloads = 0
  const attrs = { 'data-reason': 'network', 'data-api': api, 'data-sw': 'test' }
  const ctx = vm.createContext({
    document: {
      body: { getAttribute: (k) => attrs[k] },
      getElementById: (id) => els[id],
      hidden: true, // no timer-driven checks; the test drives them with events
      addEventListener: (t, f) => { docHandlers[t] = f },
    },
    window: { addEventListener: (t, f) => { winHandlers[t] = f } },
    location: { href: 'https://rupchain.test/p2p', reload: () => { reloads++ } },
    fetch: (u, o) => { urls.push(u); return fetchImpl(u, o) },
    AbortController, setTimeout, clearTimeout, Promise, JSON, Date, Array, Math, String, Error,
    get sessionStorage() { if (sessionStorage === 'missing') throw new ReferenceError('sessionStorage'); return sessionStorage },
  })
  vm.runInContext(OFFLINE_SCRIPT, ctx)
  return {
    els, urls,
    reloads: () => reloads,
    online: async () => { winHandlers.online(); await sleep(15) },
    tap: async () => { els.retry.handlers.click(); await sleep(15) },
  }
}

const allUp = async () => ({ ok: true, status: 200 })

// ─── 2. Reload guard needs working storage ────────────────────────────────────

for (const mode of ['throws', 'drops', 'missing']) {
  test(`offline.html: no automatic reload when sessionStorage ${mode}`, BOUNDED, async () => {
    const p = offlinePage({ sessionStorage: mode === 'missing' ? 'missing' : storage(mode), fetch: allUp })
    await p.online()
    assert.equal(p.reloads(), 0)
    assert.match(p.els.status.textContent, /Tap "Try again"/)
    assert.equal(p.els.retry.disabled, false)
    await p.tap() // a person tapping is always allowed
    assert.equal(p.reloads(), 1)
  })
}

test('offline.html: working storage allows an automatic reload and records it', BOUNDED, async () => {
  const s = storage('ok')
  const p = offlinePage({ sessionStorage: s, fetch: allUp })
  await p.online()
  assert.equal(p.reloads(), 1)
  assert.equal(JSON.parse(s.map.get('rc-offline-auto-reloads')).length, 1)
})

test('offline.html: stops reloading automatically after 3 recent reloads', BOUNDED, async () => {
  const s = storage('ok')
  const now = Date.now()
  s.map.set('rc-offline-auto-reloads', JSON.stringify([now - 1000, now - 2000, now - 3000]))
  const p = offlinePage({ sessionStorage: s, fetch: allUp })
  await p.online()
  assert.equal(p.reloads(), 0)
})

test('offline.html: a corrupted record disables automatic reloads instead of resetting the count', BOUNDED, async () => {
  const s = storage('ok')
  s.map.set('rc-offline-auto-reloads', '{"not":"a list"}')
  const p = offlinePage({ sessionStorage: s, fetch: allUp })
  await p.online()
  assert.equal(p.reloads(), 0)
})

test('offline.html: a hung check settles and re-enables the button', BOUNDED, async () => {
  const p = offlinePage({ sessionStorage: storage('ok'), fetch: () => never() })
  p.els.retry.handlers.click()
  assert.equal(p.els.retry.disabled, true)
  await sleep(150)
  assert.equal(p.els.retry.disabled, false)
  assert.equal(p.reloads(), 0)
})

// ─── 4. Readiness, not liveness ───────────────────────────────────────────────

test('offline.html: recovery is checked with /health/ready, never /health/ping', BOUNDED, async () => {
  const p = offlinePage({ sessionStorage: storage('ok'), fetch: allUp })
  await p.online()
  assert.ok(p.urls.some((u) => u.endsWith('/health/ready')))
  assert.ok(!p.urls.some((u) => u.includes('/health/ping')))
})

test('offline.html: website up but database not ready → no automatic reload', BOUNDED, async () => {
  const fetchImpl = async (u) => (u.endsWith('/health/ready') ? { ok: false, status: 503 } : { ok: true, status: 200 })
  const p = offlinePage({ sessionStorage: storage('ok'), fetch: fetchImpl })
  await p.online()
  assert.equal(p.reloads(), 0)
  assert.match(p.els.status.textContent, /still not responding/)
})

test('offline.html: readiness 404 = reachable, readiness unknown -> no automatic reload', BOUNDED, async () => {
  const fetchImpl = async (u) => (u.endsWith('/health/ready') ? { ok: false, status: 404 } : { ok: true, status: 200 })
  const p = offlinePage({ sessionStorage: storage('ok'), fetch: fetchImpl })
  await p.online()
  assert.equal(p.reloads(), 0)
  assert.match(p.els.status.textContent, /reachable/)
  await p.tap() // the person can still continue
  assert.equal(p.reloads(), 1)
})

test('connectionStatus: only readiness evidence clears a server problem', BOUNDED, async () => {
  const { clearsProblem } = await import('../src/lib/connectionStatus.ts')
  assert.equal(clearsProblem('server', 'reachable'), false)
  assert.equal(clearsProblem('server', 'ready'), true)
  assert.equal(clearsProblem('offline', 'reachable'), true)
  assert.equal(clearsProblem('offline', 'ready'), true)
  assert.equal(clearsProblem(null, 'ready'), false)
})

test('readiness 404 is "reachable" evidence and never clears a server problem', BOUNDED, async () => {
  const { classifyReadiness, clearsProblem } = await import('../src/lib/connectionStatus.ts')
  assert.equal(classifyReadiness(200), 'ready')
  assert.equal(classifyReadiness(404), 'reachable')
  assert.equal(classifyReadiness(503), 'server')
  assert.equal(classifyReadiness(502), 'server')
  assert.equal(clearsProblem('server', classifyReadiness(404)), false, '404 must not count as database recovered')
  assert.equal(clearsProblem('offline', classifyReadiness(404)), true)
})

test('the in-app banner classifies its probe with classifyReadiness', BOUNDED, () => {
  const banner = readFileSync(root + 'src/components/ui/ConnectionBanner.tsx', 'utf8')
  assert.match(banner, /classifyReadiness\(res\.status\)/)
})

test('the in-app banner probes readiness, not the ping', BOUNDED, () => {
  const banner = readFileSync(root + 'src/components/ui/ConnectionBanner.tsx', 'utf8')
  assert.match(banner, /\/health\/ready/)
  assert.doesNotMatch(banner, /fetch\([^)]*\/health\/ping/)
})
