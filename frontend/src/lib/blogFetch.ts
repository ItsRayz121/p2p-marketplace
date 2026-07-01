// Server-side blog fetches for the public /blog pages + sitemap. Plain fetch
// against the backend (no client-only imports).
import type { BlogPost, BlogPostSummary } from './api'

// These run on the Vercel server, not in the browser. If the public API host
// (NEXT_PUBLIC_API_URL, e.g. api.rupchain.com) sits behind Cloudflare bot
// protection, Cloudflare can block server-to-server requests from Vercel's
// datacenter IPs — the browser passes, but SSR gets nothing, so every post
// 404s and the list shows "No posts yet". Set BACKEND_ORIGIN_URL (server-only,
// NOT NEXT_PUBLIC_) to the backend's raw origin (e.g. the *.up.railway.app URL)
// so SSR talks to the origin directly and bypasses Cloudflare. Falls back to
// the public URL when unset, so existing setups keep working.
// Normalise the configured origin: strip a trailing slash and, if someone set
// BACKEND_ORIGIN_URL to a bare host (e.g. "foo.up.railway.app" with no scheme),
// prepend https:// so `fetch` gets an absolute URL instead of throwing.
function normaliseOrigin(raw: string): string {
  let v = raw.trim().replace(/\/$/, '')
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`
  return v
}

const API = normaliseOrigin(process.env.BACKEND_ORIGIN_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001')

// One-time visibility into which origin SSR is using (server logs only). Helps
// confirm whether BACKEND_ORIGIN_URL took effect on the deployment vs. silently
// falling back to the Cloudflare-fronted public host.
const USING_ORIGIN_OVERRIDE = !!process.env.BACKEND_ORIGIN_URL

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

export interface BlogList {
  posts: BlogPostSummary[]
  total: number
  page: number
  pageSize: number
}

export async function fetchBlogList(params: { page?: number; category?: string; tag?: string } = {}): Promise<BlogList> {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.category) qs.set('category', params.category)
  if (params.tag) qs.set('tag', params.tag)
  const url = `${API}/api/v1/blog?${qs.toString()}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) console.error(`[blogFetch] list ${res.status} from ${url} (originOverride=${USING_ORIGIN_OVERRIDE})`)
    return (await unwrap<BlogList>(res)) ?? { posts: [], total: 0, page: 1, pageSize: 12 }
  } catch (err) {
    console.error(`[blogFetch] list threw for ${url} (originOverride=${USING_ORIGIN_OVERRIDE}):`, err)
    return { posts: [], total: 0, page: 1, pageSize: 12 }
  }
}

export async function fetchBlogPost(slug: string): Promise<BlogPost | null> {
  // `no-store`: never cache an individual post (especially a "not found"
  // result). Without this, opening a slug before it was published cached the
  // 404 for the whole revalidate window, so publishing didn't make it live.
  const url = `${API}/api/v1/blog/post/${encodeURIComponent(slug)}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) console.error(`[blogFetch] post ${res.status} from ${url} (originOverride=${USING_ORIGIN_OVERRIDE})`)
    return await unwrap<BlogPost>(res)
  } catch (err) {
    console.error(`[blogFetch] post threw for ${url} (originOverride=${USING_ORIGIN_OVERRIDE}):`, err)
    return null
  }
}

/** Recent published posts for sitemap generation. */
export async function fetchPublishedForSitemap(): Promise<BlogPostSummary[]> {
  try {
    const res = await fetch(`${API}/api/v1/blog?pageSize=50`, { next: { revalidate: 300 } })
    const data = await unwrap<BlogList>(res)
    return data?.posts ?? []
  } catch {
    return []
  }
}
