'use client'

// Renders a blog post the way the public article page does (same `blog-article`
// styles, cover, meta line, tags) from an in-memory snapshot. Shared by the
// admin editor's live preview tab so "what you see" matches the published page.

export const BLOG_PREVIEW_CHANNEL = 'rupchain-blog-preview'
export const BLOG_PREVIEW_STORAGE_KEY = 'rupchain-blog-preview-snapshot'

export interface BlogPreviewSnapshot {
  title: string
  category: string
  subcategory: string
  bodyHtml: string
  coverImageUrl: string
  coverImageAlt: string
  coverImageCaption: string
  tags: string[]
  authorName: string
  publishedAt: string | null
}

// Mirror the server's estimateReadingMinutes exactly (strip tags → collapse
// whitespace → words / 200) so the preview count matches what gets saved.
function readingMinutesFor(bodyHtml: string): number {
  const text = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const words = text ? text.split(' ').length : 0
  return Math.max(1, Math.round(words / 200))
}

export function BlogArticlePreview({ snapshot }: { snapshot: BlogPreviewSnapshot }) {
  const { title, category, subcategory, bodyHtml, coverImageUrl, coverImageAlt, coverImageCaption, tags, authorName, publishedAt } = snapshot
  const readingMinutes = readingMinutesFor(bodyHtml)
  // A published post being edited shows its real date; a draft has none yet, so
  // we stand in with today (what it'll get on publish).
  const dateLabel = (publishedAt ? new Date(publishedAt) : new Date())
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const hasBody = bodyHtml && bodyHtml !== '<p></p>'

  return (
    <article className="px-5 sm:px-8 py-8 min-w-0">
      {category && (
        <span className="text-[11px] font-bold uppercase tracking-wide text-primary">
          {category}{subcategory ? ` · ${subcategory}` : ''}
        </span>
      )}
      <h1 className="mt-1.5 text-3xl font-bold leading-tight text-text-primary sm:text-4xl">
        {title || 'Untitled post'}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-muted">
        <span>By {authorName}</span>
        <span>·</span><span>{dateLabel}</span>
        <span>·</span><span>{readingMinutes} min read</span>
      </div>

      {coverImageUrl && (
        <figure className="mt-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={coverImageUrl} alt={coverImageAlt || title} className="w-full rounded-xl border border-border" />
          {coverImageCaption && (
            <figcaption className="mt-2 text-center text-sm italic text-text-muted">{coverImageCaption}</figcaption>
          )}
        </figure>
      )}

      {hasBody ? (
        <div className="blog-article mt-8" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      ) : (
        <p className="mt-8 text-text-muted italic">Nothing written yet — add some article body to preview it.</p>
      )}

      {tags.length > 0 && (
        <div className="mt-10 flex flex-wrap gap-2">
          {tags.map((t) => (
            <span key={t} className="rounded-full border border-border bg-surface-alt px-2.5 py-1 text-xs font-medium text-text-secondary">#{t}</span>
          ))}
        </div>
      )}
    </article>
  )
}
