// Server-side blog fetches for the public /blog pages + sitemap. Plain fetch
// against the backend (no client-only imports), with ISR caching so published
// posts are fast and SEO-friendly without hammering the API.
import type { BlogPost, BlogPostSummary } from './api'

const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

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
  try {
    const res = await fetch(`${API}/api/v1/blog?${qs.toString()}`, { cache: 'no-store' })
    return (await unwrap<BlogList>(res)) ?? { posts: [], total: 0, page: 1, pageSize: 12 }
  } catch {
    return { posts: [], total: 0, page: 1, pageSize: 12 }
  }
}

export async function fetchBlogPost(slug: string): Promise<BlogPost | null> {
  try {
    // `no-store`: never cache an individual post (especially a "not found"
    // result). Without this, opening a slug before it was published cached the
    // 404 for the whole revalidate window, so publishing didn't make it live.
    const res = await fetch(`${API}/api/v1/blog/post/${encodeURIComponent(slug)}`, { cache: 'no-store' })
    return await unwrap<BlogPost>(res)
  } catch {
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
