import Link from 'next/link'
import type { Metadata } from 'next'
import { Eye } from 'lucide-react'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import Footer from '@/components/layout/Footer'
import { BlogSearchBox } from '@/components/blog/BlogSearchBox'
import { buildMeta } from '@/lib/metadata'
import { fetchBlogList } from '@/lib/blogFetch'

export const metadata: Metadata = buildMeta(
  'Blog — RupChain',
  'Guides and updates on buying and selling crypto in Pakistan — USDT, JazzCash & Easypaisa, gas fees, security, and staying safe in P2P trading.',
  '/blog',
)

// Render fresh so newly published posts appear in the listing right away.
export const dynamic = 'force-dynamic'

function fmtDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function BlogIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; category?: string; tag?: string; q?: string }>
}) {
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page) || 1)
  const q = sp.q?.trim() || undefined
  const { posts, total, pageSize } = await fetchBlogList({ page, category: sp.category, tag: sp.tag, q })
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-h-screen bg-surface">
      <MarketingHeader />

      <section className="border-b border-slate-800 bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
          <h1 className="text-3xl font-bold text-white sm:text-4xl">RupChain Blog</h1>
          <p className="mt-3 max-w-2xl text-slate-300">
            Guides, tips, and updates on trading crypto safely in Pakistan — USDT, local payments, gas fees, and more.
          </p>
          <div className="mt-6 max-w-md">
            <BlogSearchBox initial={q ?? ''} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        {q && (
          <p className="mb-6 text-sm text-text-muted">
            {total > 0 ? <>Showing {total} result{total === 1 ? '' : 's'} for </> : <>No results for </>}
            <span className="font-semibold text-text-primary">“{q}”</span>
            {' · '}
            <Link href="/blog" className="text-primary hover:underline">Clear</Link>
          </p>
        )}

        {posts.length === 0 ? (
          <div className="py-20 text-center text-text-muted">
            <p className="text-sm">{q ? 'No matching posts — try a different search.' : 'No posts yet — check back soon.'}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map((p) => (
                <Link
                  key={p.slug}
                  href={`/blog/${p.slug}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-border bg-canvas transition-all hover:border-primary/30 hover:shadow-card-md"
                >
                  {p.coverImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.coverImageUrl} alt={p.coverImageAlt || p.title} className="aspect-video w-full object-cover" />
                  ) : (
                    <div className="aspect-video w-full bg-gradient-to-br from-slate-800 to-blue-950" />
                  )}
                  <div className="flex flex-1 flex-col p-4">
                    {p.category && <span className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-primary">{p.category}</span>}
                    <h2 className="text-base font-semibold leading-snug text-text-primary transition-colors line-clamp-2 group-hover:text-primary">{p.title}</h2>
                    {p.excerpt && <p className="mt-1.5 flex-1 text-sm text-text-muted line-clamp-3">{p.excerpt}</p>}
                    <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                      <span>{fmtDate(p.publishedAt)}</span>
                      <span>·</span>
                      <span>{p.readingMinutes} min read</span>
                      {typeof p.viewCount === 'number' && (
                        <><span>·</span><span className="inline-flex items-center gap-1"><Eye size={12} /> {p.viewCount.toLocaleString('en-US')}</span></>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-10 flex items-center justify-center gap-3">
                {page > 1 && (
                  <Link href={`/blog?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt">← Previous</Link>
                )}
                <span className="text-sm text-text-muted">Page {page} of {totalPages}</span>
                {page < totalPages && (
                  <Link href={`/blog?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt">Next →</Link>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <Footer />
    </div>
  )
}
