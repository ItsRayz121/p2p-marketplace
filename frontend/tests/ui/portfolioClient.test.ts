import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { portfolioApi, portfolioAdminApi, isNetworkError, ApiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

/**
 * The REAL API client against a fake server. Most UI tests replace the client with a mock, so they
 * can't notice a wrong URL, method, body or response shape; this file does.
 */
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
let calls: Call[]
let reply: (c: Call) => { status?: number; json: unknown } | 'network-error'

function install() {
  calls = []
  reply = () => ({ json: { success: true, data: {} } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    const call: Call = { url: String(url), method: String(init.method ?? 'GET'), headers, body: init.body ? JSON.parse(String(init.body)) : undefined }
    if (call.url.endsWith('/auth/csrf')) return new Response(JSON.stringify({ success: true, data: { token: 'csrf-123' } }), { status: 200 })
    calls.push(call)
    const r = reply(call)
    if (r === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
}

const last = () => calls[calls.length - 1]!
const path = (c: Call) => c.url.replace(/^https?:\/\/[^/]+/, '').replace(/^.*?(\/api\/v1)/, '$1')

beforeEach(() => {
  install()
  useAuthStore.setState({ accessToken: 'tok-abc', csrfToken: null, user: null })
})
afterEach(() => vi.unstubAllGlobals())

describe('every call goes to the right route with the right method and body', () => {
  const ok = (data: unknown) => { reply = () => ({ json: { success: true, data } }) }

  it('GET /portfolio/assets (with archived tokens by default)', async () => {
    ok([{ id: 'a1' }])
    expect(await portfolioApi.listAssets()).toEqual([{ id: 'a1' }])
    expect(path(last())).toBe('/api/v1/portfolio/assets?includeArchived=1')
    expect(last().method).toBe('GET')
    await portfolioApi.listAssets(false)
    expect(path(last())).toBe('/api/v1/portfolio/assets')
  })
  it('POST /portfolio/assets with the token as JSON', async () => {
    ok({ id: 'a1' })
    await portfolioApi.addAsset({ name: 'Meta Earth', symbol: null, sourceUrl: 'https://x.example/' })
    expect(path(last())).toBe('/api/v1/portfolio/assets')
    expect(last().method).toBe('POST')
    expect(last().body).toEqual({ name: 'Meta Earth', symbol: null, sourceUrl: 'https://x.example/' })
    expect(last().headers['Content-Type']).toBe('application/json')
  })
  it('PATCH /portfolio/assets/:id, with the id encoded', async () => {
    ok({ id: 'a b/c' })
    await portfolioApi.updateAsset('a b/c', { name: 'New' })
    expect(path(last())).toBe('/api/v1/portfolio/assets/a%20b%2Fc')
    expect(last().method).toBe('PATCH')
  })
  it('archive, unarchive and delete use the right verbs and send NO body or content type', async () => {
    await portfolioApi.archiveAsset('a1')
    expect([path(last()), last().method, last().body, last().headers['Content-Type']]).toEqual(['/api/v1/portfolio/assets/a1/archive', 'POST', undefined, undefined])
    await portfolioApi.unarchiveAsset('a1')
    expect([path(last()), last().method]).toEqual(['/api/v1/portfolio/assets/a1/unarchive', 'POST'])
    await portfolioApi.deleteAsset('a1')
    expect([path(last()), last().method, last().headers['Content-Type']]).toEqual(['/api/v1/portfolio/assets/a1', 'DELETE', undefined])
  })
  it('entries: list, add (decimal strings preserved), delete', async () => {
    ok([])
    await portfolioApi.listEvents('a1')
    expect([path(last()), last().method]).toEqual(['/api/v1/portfolio/assets/a1/events', 'GET'])
    ok({ id: 'e1' })
    const input = { type: 'BUY' as const, occurredAt: '2026-01-02T00:00:00.000Z', quantity: '0.10000000000000001', consideration: '125000.50', quote: 'USDT' as const, fxRate: '278.5', clientRequestId: 'req-12345678' }
    await portfolioApi.addEvent('a1', input)
    expect([path(last()), last().method]).toEqual(['/api/v1/portfolio/assets/a1/events', 'POST'])
    expect(last().body).toEqual(input) // strings stay strings: no float rounding on the way out
    await portfolioApi.deleteEvent('a1', 'e1')
    expect([path(last()), last().method]).toEqual(['/api/v1/portfolio/assets/a1/events/e1', 'DELETE'])
  })
  it('price: sends the price as a string and the currency', async () => {
    ok({ price: '1200', quote: 'USDT', observedAt: '2026-01-01T00:00:00Z' })
    await portfolioApi.setPrice('a1', '1200', 'USDT')
    expect(path(last())).toBe('/api/v1/portfolio/assets/a1/price')
    expect(last().body).toEqual({ price: '1200', quote: 'USDT' })
    await portfolioApi.setPrice('a1', '5')
    expect(last().body).toEqual({ price: '5', quote: 'PKR' })
  })
  it('summary and performance carry the currency and dates as query parameters', async () => {
    ok({})
    await portfolioApi.summary('USDT')
    expect(path(last())).toBe('/api/v1/portfolio/summary?currency=USDT')
    await portfolioApi.summary()
    expect(path(last())).toBe('/api/v1/portfolio/summary?currency=PKR')
    await portfolioApi.performance({ currency: 'PKR' })
    expect(path(last())).toBe('/api/v1/portfolio/performance?currency=PKR')
    await portfolioApi.performance({ currency: 'USDT', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' })
    const u = new URL(last().url, 'http://x')
    expect(u.searchParams.get('currency')).toBe('USDT')
    expect(u.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z')
    expect(u.searchParams.get('to')).toBe('2026-02-01T00:00:00.000Z')
  })
  it('export, status, import and the listing suggestion', async () => {
    ok({})
    await portfolioApi.exportAll()
    expect(path(last())).toBe('/api/v1/portfolio/export')
    await portfolioApi.status()
    expect(path(last())).toBe('/api/v1/portfolio/status')
    await portfolioApi.importCtm(true)
    expect([path(last()), last().method, last().body]).toEqual(['/api/v1/portfolio/import/ctm', 'POST', { dryRun: true }])
    await portfolioApi.importCtm(false)
    expect(last().body).toEqual({ dryRun: false })
    await portfolioApi.suggestListing('a1')
    expect([path(last()), last().method, last().body]).toEqual(['/api/v1/portfolio/assets/a1/interest', 'POST', { consent: true }])
    await portfolioApi.withdrawListingSuggestion('a1')
    expect([path(last()), last().method]).toEqual(['/api/v1/portfolio/assets/a1/interest', 'DELETE'])
  })
  it('the admin aggregate is on the admin path', async () => {
    ok({ groups: [] })
    await portfolioAdminApi.interest()
    expect(path(last())).toBe('/api/v1/admin/portfolio/interest')
  })
})

describe('credentials and protection', () => {
  it('every call carries the access token; writes also carry the CSRF token; reads do not need it', async () => {
    await portfolioApi.summary()
    expect(last().headers['Authorization']).toBe('Bearer tok-abc')
    expect(last().headers['X-CSRF-Token']).toBeUndefined()
    await portfolioApi.archiveAsset('a1')
    expect(last().headers['Authorization']).toBe('Bearer tok-abc')
    expect(last().headers['X-CSRF-Token']).toBe('csrf-123')
  })
  it('a write clears cached reads, so a number is never stale after recording an entry', async () => {
    let n = 0
    reply = (c) => ({ json: { success: true, data: c.method === 'GET' ? { n: ++n } : {} } })
    const a = await portfolioApi.summary() as unknown as { n: number }
    await portfolioApi.addEvent('a1', { type: 'BUY', occurredAt: '2026-01-02T00:00:00.000Z', quantity: '1', consideration: '1' })
    const b = await portfolioApi.summary() as unknown as { n: number }
    expect(b.n).toBeGreaterThan(a.n)
  })
  it('two identical reads in a row are both sent (nothing about the portfolio is cached)', async () => {
    reply = () => ({ json: { success: true, data: [] } })
    await portfolioApi.listAssets()
    const before = calls.length
    await portfolioApi.listAssets()
    expect(calls.length).toBe(before + 1)
  })
})

describe('what the screens show when something goes wrong', () => {
  it('a server refusal surfaces the server\'s own message and code', async () => {
    reply = () => ({ status: 400, json: { success: false, error: 'VALIDATION_ERROR', message: 'Date cannot be in the future' } })
    const err = await portfolioApi.addEvent('a1', { type: 'BUY', occurredAt: '2999-01-01T00:00:00.000Z', quantity: '1', consideration: '1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('Date cannot be in the future')
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(isNetworkError(err)).toBe(false)
  })
  it('the "feature switched off" answer reads cleanly', async () => {
    reply = () => ({ status: 404, json: { success: false, error: 'PORTFOLIO_DISABLED', message: 'Portfolio is not available right now' } })
    const err = await portfolioApi.listAssets().catch((e) => e)
    expect(err.message).toBe('Portfolio is not available right now')
  })
  it('a conflict (archived / has records / read-only) keeps its message', async () => {
    reply = () => ({ status: 409, json: { success: false, error: 'CONFLICT', message: 'This token has records. Archive it instead so your history is kept.' } })
    const err = await portfolioApi.deleteAsset('a1').catch((e) => e)
    expect(err.message).toMatch(/Archive it instead/)
  })
  it('a lost connection on a write is reported as a NETWORK error (so the offline queue takes over)', async () => {
    reply = () => 'network-error'
    const err = await portfolioApi.addEvent('a1', { type: 'BUY', occurredAt: '2026-01-02T00:00:00.000Z', quantity: '1', consideration: '1', clientRequestId: 'req-12345678' }).catch((e) => e)
    expect(isNetworkError(err)).toBe(true)
  })
  it('success without a data field (archive, delete) resolves cleanly', async () => {
    reply = () => ({ json: { success: true } })
    await expect(portfolioApi.archiveAsset('a1')).resolves.toBeDefined()
  })
})
