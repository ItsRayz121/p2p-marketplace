/**
 * Lightweight IP → country resolution. Uses the free, keyless HTTPS endpoint ipwho.is
 * (no bundled GeoIP database, so the deploy stays small). Best-effort only: any failure,
 * timeout, or private/loopback IP resolves to null and is simply not stored.
 *
 * Country is display/analytics metadata (admin user profile + referral country breakdown);
 * it is never on a hot path, so resolution at registration is fire-and-forget.
 */
import { db } from './prisma'
import { logger } from './logger'

export interface CountryInfo { country: string; countryCode: string }

/** Private / loopback / link-local ranges we never bother geolocating. */
function isPrivateIp(ip: string): boolean {
  const v = ip.trim().replace(/^::ffff:/, '')
  if (!v || v === '::1' || v === '127.0.0.1' || v.startsWith('127.')) return true
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.') || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true
  if (v.startsWith('172.')) {
    const second = Number(v.split('.')[1])
    if (second >= 16 && second <= 31) return true
  }
  return false
}

/** Resolve a single IP to its country. Returns null on any failure or private IP. */
export async function lookupCountry(ip: string | null | undefined): Promise<CountryInfo | null> {
  if (!ip || isPrivateIp(ip)) return null
  // A request may carry "ip1, ip2" (proxy chain) — use the first, real client IP.
  const clean = ip.split(',')[0]!.trim().replace(/^::ffff:/, '')
  if (isPrivateIp(clean)) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}?fields=success,country,country_code`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const j = (await res.json()) as { success?: boolean; country?: string; country_code?: string }
    if (!j.success || !j.country || !j.country_code) return null
    return { country: j.country, countryCode: j.country_code }
  } catch {
    return null
  }
}

/** Fire-and-forget: resolve + persist a user's country. Never throws. */
export function resolveAndStoreCountry(userId: string, ip: string | null | undefined): void {
  void lookupCountry(ip)
    .then(async (info) => {
      if (!info) return
      await db.user.update({ where: { id: userId }, data: { country: info.country, countryCode: info.countryCode } })
    })
    .catch((err) => logger.error({ err, userId }, 'country resolution failed'))
}
