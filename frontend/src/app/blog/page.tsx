import Link from 'next/link'
import type { Metadata } from 'next'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import Footer from '@/components/layout/Footer'
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
  searchParams: Promise<{ page?: string; category?: string; tag?: string }>
}) {
  const sp = await searchParams
  const page = Math.max(1, Number(sp.page) || 1)
  const { posts, total, pageSize } = await fetchBlogList({ page, category: sp.category, tag: sp.tag })
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-h-screen bg-surface">
      <MarketingHeader />

      <section className="bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
          <h1 className="text-3xl sm:text-4xl font-bold text-white">RupChain Blog</h1>
          <p className="mt-3 text-slate-300 max-w-2xl">
            Guides, tips, and updates on trading crypto safely in Pakistan — USDT, local payments, gas fees, and more.
          </p>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {posts.length === 0 ? (
          <div className="py-20 text-center text-text-muted">
            <p className="text-sm">No posts yet — check back soon.</p>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {posts.map((p) => (
                <Link
                  key={p.slug}
                  href={`/blog/${p.slug}`}
                  className="group bg-canvas border border-border rounded-xl overflow-hidden hover:shadow-card-md hover:border-primary/30 transition-all flex flex-col"
                >
                  {p.coverImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.coverImageUrl} alt={p.coverImageAlt || p.title} className="w-full aspect-video object-cover" />
                  ) : (
                    <div className="w-full aspect-video bg-gradient-to-br from-slate-800 to-blue-950" />
                  )}
                  <div className="p-4 flex flex-col flex-1">
                    {p.category && <span className="text-[11px] font-bold uppercase tracking-wide text-primary mb-1.5">{p.category}</span>}
                    <h2 className="text-base font-semibold text-text-primary leading-snug group-hover:text-primary transition-colors line-clamp-2">{p.title}</h2>
                    {p.excerpt && <p className="mt-1.5 text-sm text-text-muted line-clamp-3 flex-1">{p.excerpt}</p>}
                    <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                      <span>{fmtDate(p.publishedAt)}</span>
                      <span>·</span>
                      <span>{p.readingMinutes} min read</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-10">
                {page > 1 && (
                  <Link href={`/blog?page=${page - 1}`} className="px-4 py-2 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-alt">← Previous</Link>
                )}
                <span className="text-sm text-text-muted">Page {page} of {totalPages}</span>
                {page < totalPages && (
                  <Link href={`/blog?page=${page + 1}`} className="px-4 py-2 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-alt">Next →</Link>
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
