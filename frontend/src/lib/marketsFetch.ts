// Server-side Markets fetches — used by app/markets/**/page.tsx (SSR + SEO
// metadata) and the sitemap. Plain fetch against the backend, no client-only
// imports (same reasoning as blogFetch.ts: this runs on the server, and
// api.ts pulls in a zustand auth store that must never touch SSR).
import type { MarketsOverview, MarketActivity } from './api'

function normaliseOrigin(raw: string): string {
  let v = raw.trim().replace(/\/$/, '')
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`
  return v
}

// See blogFetch.ts: BACKEND_ORIGIN_URL lets SSR bypass Cloudflare bot
// protection in front of the public API host by hitting the raw origin.
const API = normaliseOrigin(process.env.BACKEND_ORIGIN_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001')

async function unwrap<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null
  try {
    const body = (await res.json()) as { data?: T } | T
    if (body && typeof body === 'object' && 'data' in body && (body as { data?: T }).data !== undefined) {
      return (body as { data: T }).data
    }
    return body as T
  } catch {
    return null
  }
}

/** Prices move constantly — never cache beyond the backend's own 45s Redis TTL. */
export async function fetchMarketsOverview(): Promise<MarketsOverview | null> {
  const url = `${API}/api/v1/markets/overview`
  try {
    const res = await fetch(url, { next: { revalidate: 30 } })
    if (!res.ok) console.error(`[marketsFetch] overview ${res.status} from ${url}`)
    return await unwrap<MarketsOverview>(res)
  } catch (err) {
    console.error(`[marketsFetch] overview threw for ${url}:`, err)
    return null
  }
}

export interface CtmTokenDetail {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl?: string | null
  bannerUrl?: string | null
  description: string
  riskTier: string
  riskNotes?: string | null
  riskLabels: string[]
  settlementType: string
  network?: string | null
  officialWebsite?: string | null
  officialTwitter?: string | null
  officialTelegram?: string | null
  totalTrades: number
  totalVolumePkr: string
  lastTradedAt?: string | null
  _count?: { listings: number; requests: number }
}

/** `no-store`: a token that just got approved (or delisted) must show up/disappear immediately. */
export async function fetchCtmTokenBySlug(slug: string): Promise<CtmTokenDetail | null> {
  const url = `${API}/api/v1/ctm/tokens/${encodeURIComponent(slug)}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return await unwrap<CtmTokenDetail>(res)
  } catch (err) {
    console.error(`[marketsFetch] token threw for ${url}:`, err)
    return null
  }
}

/** Order-book snapshot + 24h high/low/volume + recent trades for one token's detail page. */
export async function fetchMarketActivity(slug: string): Promise<MarketActivity | null> {
  const url = `${API}/api/v1/markets/${encodeURIComponent(slug)}/activity`
  try {
    const res = await fetch(url, { next: { revalidate: 20 } })
    if (!res.ok) return null
    return await unwrap<MarketActivity>(res)
  } catch (err) {
    console.error(`[marketsFetch] activity threw for ${url}:`, err)
    return null
  }
}

/** Token slugs for the /markets/[slug] sitemap entries. */
export async function fetchMarketSlugsForSitemap(): Promise<{ slug: string; lastModified: Date }[]> {
  const overview = await fetchMarketsOverview()
  if (!overview) return []
  const now = new Date()
  return overview.rows.map((r) => ({
    slug: r.slug,
    lastModified: r.lastTradedAt ? new Date(r.lastTradedAt) : now,
  }))
}
