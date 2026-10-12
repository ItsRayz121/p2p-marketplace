import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { resolveClientIp } from '../requestContext'

describe('resolveClientIp (no edge secret: unchanged behaviour)', () => {
  it('prefers CF-Connecting-IP, then X-Real-IP, then the first X-Forwarded-For entry', () => {
    expect(resolveClientIp({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }, 'f', undefined)).toBe('1.1.1.1')
    expect(resolveClientIp({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }, 'f', undefined)).toBe('2.2.2.2')
    expect(resolveClientIp({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' }, 'f', undefined)).toBe('3.3.3.3')
    expect(resolveClientIp({}, 'fallback', undefined)).toBe('fallback')
  })
})

describe('resolveClientIp (EDGE_SHARED_SECRET set)', () => {
  const secret = 's3cret-value-1234567890'
  it('honours Cloudflare headers when the secret is presented', () => {
    expect(resolveClientIp({ 'cf-connecting-ip': '9.9.9.9', 'x-edge-secret': secret, 'x-forwarded-for': 'a, b' }, 'f', secret)).toBe('9.9.9.9')
  })
  it('ignores forged Cloudflare/real-ip headers when the secret is missing or wrong', () => {
    const forged = { 'cf-connecting-ip': '6.6.6.6', 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }
    expect(resolveClientIp(forged, 'f', secret)).toBe('203.0.113.9') // last hop = appended by our proxy
    expect(resolveClientIp({ ...forged, 'x-edge-secret': 'wrong-value-wrong-value' }, 'f', secret)).toBe('203.0.113.9')
  })
  it('falls back when there is no X-Forwarded-For at all', () => {
    expect(resolveClientIp({ 'cf-connecting-ip': '6.6.6.6' }, 'socket-ip', secret)).toBe('socket-ip')
  })
})

describe('req.ip override pattern used by app.ts', () => {
  it('a hook can make req.ip the resolved client IP instead of the edge address', async () => {
    const app = Fastify({ trustProxy: true })
    app.addHook('onRequest', async (req) => {
      const ip = resolveClientIp(req.headers as Record<string, unknown>, req.ip, undefined)
      if (ip && ip !== req.ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true })
    })
    app.get('/ip', async (req) => ({ ip: req.ip }))
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '172.69.111.5, 152.233.68.2', 'cf-connecting-ip': '203.0.113.77' },
    })
    expect(res.json()).toEqual({ ip: '203.0.113.77' })
    await app.close()
  })
})
