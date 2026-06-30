import type { MetadataRoute } from 'next'
import { fetchPublishedForSitemap } from '@/lib/blogFetch'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  let blogEntries: MetadataRoute.Sitemap = []
  try {
    const posts = await fetchPublishedForSitemap()
    blogEntries = posts.map((p) => ({
      url: `${BASE_URL}/blog/${p.slug}`,
      lastModified: p.publishedAt ? new Date(p.publishedAt) : now,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    }))
  } catch { /* sitemap must never throw — degrade to static routes */ }

  return [
    { url: BASE_URL,                       lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE_URL}/blog`,             lastModified: now, changeFrequency: 'daily',   priority: 0.7 },
    ...blogEntries,
    { url: `${BASE_URL}/marketplace`,      lastModified: now, changeFrequency: 'always',  priority: 0.9 },
    { url: `${BASE_URL}/ctm`,              lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
    { url: `${BASE_URL}/gas`,              lastModified: now, changeFrequency: 'daily',   priority: 0.8 },
    { url: `${BASE_URL}/register`,         lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE_URL}/login`,            lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE_URL}/fees`,             lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/about`,            lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE_URL}/terms`,            lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE_URL}/privacy`,          lastModified: now, changeFrequency: 'monthly', priority: 0.3 },
    { url: `${BASE_URL}/help`,             lastModified: now, changeFrequency: 'weekly',  priority: 0.4 },
    { url: `${BASE_URL}/leaderboard`,      lastModified: now, changeFrequency: 'daily',   priority: 0.4 },
    { url: `${BASE_URL}/levels`,           lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
  ]
}
