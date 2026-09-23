// Server-side blog fetches for the public /blog pages + sitemap. Plain fetch
// against the backend (no client-only imports).
import type { BlogPost, BlogPostSummary } from './api'

// Server-side origin selection lives in one place — see lib/serverApiOrigin.
// The homepage SSR reads the same constant, so the two can never drift.
import { SERVER_API_ORIGIN, USING_ORIGIN_OVERRIDE } from './serverApiOrigin'

const API = SERVER_API_ORIGIN

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

// Both reads below are cached on the same 60s clock as their pages (see
// `revalidate` in page.tsx / [slug]/page.tsx) instead of `no-store`, and capped
// by an 8s deadline for the same reason as the homepage: ISR regeneration runs
// in the background while visitors still get the previous page, so a slow or
// waking backend must never be able to hold that regeneration open. A
// timed-out read resolves through the same empty-state fallback as a genuine
// backend error.
//
// This used to be `no-store`, specifically on fetchBlogPost, to stop a 404
// visited before publish from being cached for the whole revalidate window.
// That protection is moot now regardless of what happens here: the Cloudflare
// Cache Rule in front of Vercel matches `/blog*` and is configured to IGNORE
// origin cache-control and force its own 60s edge TTL — so a pre-publish 404
// was already being frozen at the edge for up to 60s no matter what this file
// sent. Matching Vercel's own cache to that same 60s window, instead of
// fighting it with no-store, means the two layers agree and a stale response
// self-heals on the same schedule everywhere. See
// memory/project_connection_reset_edge_caching.md.
const READ_OPTS = { next: { revalidate: 60 }, signal: AbortSignal.timeout(8_000) } as const

export async function fetchBlogList(params: { page?: number; category?: string; tag?: string; q?: string } = {}): Promise<BlogList> {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.category) qs.set('category', params.category)
  if (params.tag) qs.set('tag', params.tag)
  if (params.q) qs.set('q', params.q)
  const url = `${API}/api/v1/blog?${qs.toString()}`
  try {
    const res = await fetch(url, READ_OPTS)
    if (!res.ok) console.error(`[blogFetch] list ${res.status} from ${url} (originOverride=${USING_ORIGIN_OVERRIDE})`)
    return (await unwrap<BlogList>(res)) ?? { posts: [], total: 0, page: 1, pageSize: 12 }
  } catch (err) {
    console.error(`[blogFetch] list threw for ${url} (originOverride=${USING_ORIGIN_OVERRIDE}):`, err)
    return { posts: [], total: 0, page: 1, pageSize: 12 }
  }
}

export async function fetchBlogPost(slug: string): Promise<BlogPost | null> {
  const url = `${API}/api/v1/blog/post/${encodeURIComponent(slug)}`
  try {
    const res = await fetch(url, READ_OPTS)
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
