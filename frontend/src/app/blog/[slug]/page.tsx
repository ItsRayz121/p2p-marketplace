import Link from 'next/link'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import Footer from '@/components/layout/Footer'
import { BlogViewPing } from '@/components/blog/BlogViewPing'
import { fetchBlogPost } from '@/lib/blogFetch'

// Render on each request: a freshly published post must be live immediately,
// and a cached `notFound()` must never linger after publishing.
export const dynamic = 'force-dynamic'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

function fmtDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const post = await fetchBlogPost(slug)
  if (!post) return { title: 'Post not found — RupChain' }

  const title = post.metaTitle || post.title
  const description = post.metaDescription || post.excerpt || `${post.title} — RupChain blog.`
  const image = post.ogImageUrl || post.coverImageUrl || `${BASE_URL}/opengraph-image`
  const url = post.canonicalUrl || `${BASE_URL}/blog/${post.slug}`

  return {
    title,
    description,
    alternates: { canonical: url },
    ...(post.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: 'article',
      title,
      description,
      url,
      siteName: 'RupChain',
      images: [{ url: image, width: 1200, height: 630, alt: post.coverImageAlt || post.title }],
      ...(post.publishedAt ? { publishedTime: post.publishedAt } : {}),
      modifiedTime: post.updatedAt,
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  }
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = await fetchBlogPost(slug)
  if (!post) notFound()

  const url = `${BASE_URL}/blog/${post.slug}`
  const description = post.metaDescription || post.excerpt || post.title
  const image = post.ogImageUrl || post.coverImageUrl || `${BASE_URL}/opengraph-image`

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      image,
      datePublished: post.publishedAt ?? post.createdAt,
      dateModified: post.updatedAt,
      author: { '@type': 'Organization', name: post.authorName || 'RupChain', url: BASE_URL },
      publisher: {
        '@type': 'Organization',
        name: 'RupChain',
        logo: { '@type': 'ImageObject', url: `${BASE_URL}/apple-touch-icon.png` },
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: `${BASE_URL}/blog` },
        { '@type': 'ListItem', position: 3, name: post.title, item: url },
      ],
    },
  ]

  return (
    <div className="min-h-screen bg-surface">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <BlogViewPing slug={post.slug} />
      <MarketingHeader />

      <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <nav className="text-xs text-text-muted mb-4">
          <Link href="/" className="hover:text-primary">Home</Link>
          <span className="mx-1.5">/</span>
          <Link href="/blog" className="hover:text-primary">Blog</Link>
        </nav>

        {post.category && <span className="text-[11px] font-bold uppercase tracking-wide text-primary">{post.category}</span>}
        <h1 className="mt-1.5 text-3xl sm:text-4xl font-bold text-text-primary leading-tight">{post.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <span>By {post.authorName}</span>
          {post.publishedAt && <><span>·</span><span>{fmtDate(post.publishedAt)}</span></>}
          <span>·</span>
          <span>{post.readingMinutes} min read</span>
        </div>

        {post.coverImageUrl && (
          <figure className="mt-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={post.coverImageUrl} alt={post.coverImageAlt || post.title} className="w-full rounded-xl border border-border" />
            {post.coverImageCaption && (
              <figcaption className="mt-2 text-center text-sm italic text-text-muted">{post.coverImageCaption}</figcaption>
            )}
          </figure>
        )}

        <div className="blog-article mt-8" dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />

        {post.tags.length > 0 && (
          <div className="mt-10 flex flex-wrap gap-2">
            {post.tags.map((t) => (
              <span key={t} className="text-xs font-medium text-text-secondary bg-surface-alt border border-border rounded-full px-2.5 py-1">#{t}</span>
            ))}
          </div>
        )}

        <div className="mt-10 pt-6 border-t border-border flex items-center justify-between">
          <Link href="/blog" className="text-sm font-semibold text-primary hover:underline">← All posts</Link>
          <Link href="/register" className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary-hover">Start trading on RupChain</Link>
        </div>
      </article>

      <Footer />
    </div>
  )
}
