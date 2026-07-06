'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { blogApi, ctmApi, gasApi, type BlogPost, type BlogUpsert, type GasChain, ApiError } from '@/lib/api'
import { useFileUpload } from '@/hooks/useFileUpload'
import { BlogEditor } from './BlogEditor'
import { SeoChecklist } from './SeoChecklist'
import { cn } from '@/lib/utils'
import { BLOG_CATEGORY_LABELS, CATEGORY, OTHER_OPTION, subcategoriesFor } from '@/lib/blogTaxonomy'
import { Eye, X } from 'lucide-react'

const inputCls = 'w-full px-3 py-2 rounded-lg border border-border bg-canvas text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/40'
const labelCls = 'block text-xs font-semibold text-text-secondary mb-1'

export function BlogPostForm({ initial }: { initial?: BlogPost }) {
  const router = useRouter()
  const isEdit = Boolean(initial)

  const [title, setTitle] = useState(initial?.title ?? '')
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [excerpt, setExcerpt] = useState(initial?.excerpt ?? '')
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? '')
  const [coverImageUrl, setCoverImageUrl] = useState(initial?.coverImageUrl ?? '')
  const [coverImageAlt, setCoverImageAlt] = useState(initial?.coverImageAlt ?? '')
  const [coverImageCaption, setCoverImageCaption] = useState(initial?.coverImageCaption ?? '')
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '))

  // Category / subcategory are picked from a curated dropdown (see blogTaxonomy).
  // Each dropdown has an "Others" option that reveals a free-text box. We keep the
  // dropdown selection and the custom text as separate state, then derive the
  // stored string in buildPayload. On edit, an existing value that isn't in the
  // list preselects "Others" and prefills the text box so nothing is lost.
  const initCat = initial?.category ?? ''
  const [catSelect, setCatSelect] = useState(
    initCat ? (BLOG_CATEGORY_LABELS.includes(initCat) ? initCat : OTHER_OPTION) : '',
  )
  const [catCustom, setCatCustom] = useState(
    initCat && !BLOG_CATEGORY_LABELS.includes(initCat) ? initCat : '',
  )
  const initSub = initial?.subcategory ?? ''
  const [subSelect, setSubSelect] = useState(
    initSub ? (subcategoriesFor(initCat).includes(initSub) ? initSub : OTHER_OPTION) : '',
  )
  const [subCustom, setSubCustom] = useState(
    initSub && !subcategoriesFor(initCat).includes(initSub) ? initSub : '',
  )

  const categoryValue = catSelect === OTHER_OPTION ? catCustom.trim() : catSelect

  // CTM and Gas subcategories are pulled live so newly-added tokens/chains show up
  // automatically. USDT/Learn use the static lists. Fetches are best-effort — on
  // failure the static seeds in blogTaxonomy stand in, and "Others" always works.
  const [ctmSubs, setCtmSubs] = useState<string[]>([])
  const [gasSubs, setGasSubs] = useState<string[]>([])
  useEffect(() => {
    ctmApi.getTokens({ limit: 100 })
      .then((res) => {
        const tokens = (res as { tokens?: { name?: string; symbol?: string }[] }).tokens ?? []
        const labels = tokens
          .map((t) => (t.name && t.symbol ? `${t.name} (${t.symbol})` : (t.name ?? t.symbol ?? '')))
          .filter(Boolean)
        if (labels.length) setCtmSubs(Array.from(new Set(labels)))
      })
      .catch(() => { /* fall back to static seeds */ })
    gasApi.getChains()
      .then(({ chains }: { chains: GasChain[] }) => {
        const labels = chains.filter((c) => c.isActive).map((c) => c.name).filter(Boolean)
        if (labels.length) setGasSubs(Array.from(new Set(labels)))
      })
      .catch(() => { /* fall back to static seeds */ })
  }, [])

  const activeCat = catSelect === OTHER_OPTION ? '' : catSelect
  const subOptions =
    activeCat === CATEGORY.CTM && ctmSubs.length ? ctmSubs
    : activeCat === CATEGORY.GAS && gasSubs.length ? gasSubs
    : subcategoriesFor(activeCat)
  const subcategoryValue = subSelect === OTHER_OPTION ? subCustom.trim() : subSelect

  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? '')
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? '')
  const [focusKeyword, setFocusKeyword] = useState(initial?.focusKeyword ?? '')
  const [noindex, setNoindex] = useState(initial?.noindex ?? false)

  // Live publish state mirrors what's actually saved, so the badge and the
  // "View live post" link update immediately after publishing/unpublishing
  // without waiting for a reload.
  const [liveStatus, setLiveStatus] = useState(initial?.status)
  const [liveSlug, setLiveSlug] = useState(initial?.slug)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const { upload: uploadCover, uploading: uploadingCover } = useFileUpload('blog-image')

  async function handleCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      setCoverImageUrl(await uploadCover(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cover upload failed')
    }
  }

  function buildPayload(status: 'draft' | 'published'): BlogUpsert {
    return {
      title: title.trim(),
      slug: slug.trim() || undefined,
      excerpt: excerpt.trim() || null,
      bodyHtml,
      coverImageUrl: coverImageUrl || null,
      coverImageAlt: coverImageAlt.trim() || null,
      coverImageCaption: coverImageCaption.trim() || null,
      status,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      category: categoryValue.trim() || null,
      subcategory: subcategoryValue.trim() || null,
      metaTitle: metaTitle.trim() || null,
      metaDescription: metaDescription.trim() || null,
      focusKeyword: focusKeyword.trim() || null,
      noindex,
    }
  }

  async function save(status: 'draft' | 'published') {
    if (!title.trim()) { setError('Title is required'); return }
    if (!bodyHtml || bodyHtml === '<p></p>') { setError('Article body is empty'); return }
    setSaving(true); setError(null); setOk(null)
    try {
      const payload = buildPayload(status)
      if (isEdit && initial) {
        const updated = await blogApi.adminUpdate(initial.id, payload)
        setLiveStatus(updated.status)
        setLiveSlug(updated.slug)
        setOk(status === 'published' ? 'Published!' : 'Saved.')
      } else {
        const created = await blogApi.adminCreate(payload)
        router.replace(`/admin/blog/${created.id}`)
        return
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <div className="grid lg:grid-cols-3 gap-6 items-start">
      {/* Main column */}
      <div className="lg:col-span-2 space-y-4">
        <div>
          <label className={labelCls}>Title</label>
          <input className={cn(inputCls, 'text-lg font-semibold')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="How to buy USDT safely in Pakistan" />
        </div>

        <div>
          <label className={labelCls}>Article body</label>
          <BlogEditor value={bodyHtml} onChange={setBodyHtml} />
        </div>
      </div>

      {/* Sidebar — one pinned panel so it never half-scrolls: the whole column
          stays put while you edit the article, scrolling within itself when it's
          taller than the screen. */}
      <div className="space-y-5 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
          {/* Publish box — kept at the top so it's the first thing in reach. */}
          <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-text-primary">Publish</span>
              {initial && liveStatus && (
                <span className={cn('text-[11px] font-semibold px-2 py-0.5 rounded-full', liveStatus === 'published' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
                  {liveStatus}
                </span>
              )}
            </div>
            {error && <p className="text-xs text-rose-500">{error}</p>}
            {ok && <p className="text-xs text-success">{ok}</p>}
            {/* Preview — renders the post exactly as the public page will, from the
                current (unsaved) form state, so you can eyeball it before publishing. */}
            <button onClick={() => setShowPreview(true)} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-border text-sm font-semibold text-text-primary hover:bg-surface-alt">
              <Eye size={15} aria-hidden /> Preview
            </button>
            <div className="flex gap-2">
              <button onClick={() => save('draft')} disabled={saving} className="flex-1 px-3 py-2 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-alt disabled:opacity-50">
                Save draft
              </button>
              <button onClick={() => save('published')} disabled={saving} className="flex-1 px-3 py-2 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary-hover disabled:opacity-50">
                {saving ? 'Saving…' : 'Publish'}
              </button>
            </div>
            {liveStatus === 'published' && liveSlug && (
              <a href={`/blog/${liveSlug}`} target="_blank" rel="noopener" className="block text-center text-xs text-primary hover:underline">View live post ↗</a>
            )}
          </div>

          <SeoChecklist
            title={title}
            slug={slug}
            excerpt={excerpt}
            bodyHtml={bodyHtml}
            metaTitle={metaTitle}
            metaDescription={metaDescription}
            focusKeyword={focusKeyword}
            coverImageUrl={coverImageUrl}
          />

        {/* Cover image */}
        <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
          <span className="text-sm font-bold text-text-primary">Cover image</span>
          {coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverImageUrl} alt={coverImageAlt || 'cover'} className="w-full rounded-lg border border-border" />
          ) : (
            <div className="w-full aspect-video rounded-lg border border-dashed border-border flex items-center justify-center text-text-muted text-xs">No cover yet</div>
          )}
          <label className="block">
            <span className="sr-only">Upload cover</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleCover} className="block w-full text-xs text-text-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-primary/10 file:text-primary file:text-xs file:font-semibold" />
          </label>
          {uploadingCover && <p className="text-xs text-text-muted">Uploading…</p>}
          {coverImageUrl && (
            <>
              <div>
                <label className={labelCls}>Alt text <span className="text-text-muted font-normal">— hidden, for SEO & screen readers (optional)</span></label>
                <input className={inputCls} value={coverImageAlt} onChange={(e) => setCoverImageAlt(e.target.value)} placeholder="e.g. Person buying USDT on a phone" />
              </div>
              <div>
                <label className={labelCls}>Caption <span className="text-text-muted font-normal">— visible under the image (optional)</span></label>
                <input className={inputCls} value={coverImageCaption} onChange={(e) => setCoverImageCaption(e.target.value)} placeholder="e.g. Buying USDT with JazzCash in seconds" />
              </div>
              <button onClick={() => { setCoverImageUrl(''); setCoverImageAlt(''); setCoverImageCaption('') }} className="text-xs text-rose-500 hover:underline">Remove cover</button>
            </>
          )}
        </div>

        {/* Organisation */}
        <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
          <span className="text-sm font-bold text-text-primary">Details</span>
          <div>
            <label className={labelCls}>Slug (URL)</label>
            <input className={inputCls} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from title if blank" />
          </div>
          <div>
            <label className={labelCls}>Category</label>
            <select
              className={inputCls}
              value={catSelect}
              onChange={(e) => {
                const v = e.target.value
                setCatSelect(v)
                setCatCustom('')
                // Category drives the subcategory list — clear the old pick so we
                // never keep a subcategory that doesn't belong to the new category.
                setSubSelect('')
                setSubCustom('')
              }}
            >
              <option value="">— Select category —</option>
              {BLOG_CATEGORY_LABELS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value={OTHER_OPTION}>{OTHER_OPTION}</option>
            </select>
            {catSelect === OTHER_OPTION && (
              <input
                className={cn(inputCls, 'mt-2')}
                value={catCustom}
                onChange={(e) => setCatCustom(e.target.value)}
                placeholder="Type the category name"
                autoFocus
              />
            )}
          </div>
          {catSelect && (
            <div>
              <label className={labelCls}>Subcategory <span className="text-text-muted font-normal">(optional)</span></label>
              <select
                className={inputCls}
                value={subSelect}
                onChange={(e) => { setSubSelect(e.target.value); setSubCustom('') }}
              >
                <option value="">— None —</option>
                {subOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value={OTHER_OPTION}>{OTHER_OPTION}</option>
              </select>
              {subSelect === OTHER_OPTION && (
                <input
                  className={cn(inputCls, 'mt-2')}
                  value={subCustom}
                  onChange={(e) => setSubCustom(e.target.value)}
                  placeholder="Type the subcategory name"
                  autoFocus
                />
              )}
            </div>
          )}
          <div>
            <label className={labelCls}>Tags (comma-separated)</label>
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="USDT, JazzCash, P2P" />
          </div>
          <div>
            <label className={labelCls}>Excerpt (summary)</label>
            <textarea className={cn(inputCls, 'resize-y min-h-[64px]')} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} placeholder="Short summary shown in listings and search results" />
          </div>
        </div>

        {/* SEO */}
        <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
          <span className="text-sm font-bold text-text-primary">SEO</span>
          <div>
            <label className={labelCls}>Focus keyword</label>
            <input className={inputCls} value={focusKeyword} onChange={(e) => setFocusKeyword(e.target.value)} placeholder="buy USDT Pakistan" />
          </div>
          <div>
            <label className={labelCls}>Meta title <span className="text-text-muted">({metaTitle.length}/60)</span></label>
            <input className={inputCls} value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} placeholder="Defaults to the title" />
          </div>
          <div>
            <label className={labelCls}>Meta description <span className="text-text-muted">({metaDescription.length}/160)</span></label>
            <textarea className={cn(inputCls, 'resize-y min-h-[64px]')} value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} placeholder="Defaults to the excerpt" />
          </div>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} />
            Hide from search engines (noindex)
          </label>
        </div>
      </div>
    </div>

    {showPreview && (
      <BlogPreviewModal
        title={title}
        category={categoryValue}
        subcategory={subcategoryValue}
        bodyHtml={bodyHtml}
        coverImageUrl={coverImageUrl}
        coverImageAlt={coverImageAlt}
        coverImageCaption={coverImageCaption}
        tags={tags.split(',').map((t) => t.trim()).filter(Boolean)}
        onClose={() => setShowPreview(false)}
      />
    )}
    </>
  )
}

// ─── Live preview modal ────────────────────────────────────────────────────────
// Renders the post the way the public article page does (same `blog-article`
// styles, cover, meta line, tags) from the current unsaved form state. A banner
// makes clear it's a preview, and the reading time is a rough client estimate.

function BlogPreviewModal({
  title, category, subcategory, bodyHtml, coverImageUrl, coverImageAlt, coverImageCaption, tags, onClose,
}: {
  title: string
  category: string
  subcategory: string
  bodyHtml: string
  coverImageUrl: string
  coverImageAlt: string
  coverImageCaption: string
  tags: string[]
  onClose: () => void
}) {
  const words = bodyHtml.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length
  const readingMinutes = Math.max(1, Math.round(words / 200))
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const hasBody = bodyHtml && bodyHtml !== '<p></p>'

  return (
    <div className="fixed inset-0 z-50 bg-black/50 overflow-y-auto" onClick={onClose}>
      <div className="min-h-full py-8 px-4 flex justify-center">
        <div className="relative w-full max-w-3xl bg-surface rounded-2xl shadow-xl border border-border" onClick={(e) => e.stopPropagation()}>
          {/* Preview banner + close */}
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-border bg-surface/95 backdrop-blur px-5 py-3">
            <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
              <Eye size={14} aria-hidden /> Preview — not published
            </span>
            <button onClick={onClose} className="inline-flex items-center gap-1 text-sm font-semibold text-text-secondary hover:text-text-primary">
              <X size={16} aria-hidden /> Close
            </button>
          </div>

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
              <span>By RupChain</span>
              <span>·</span><span>{today}</span>
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
        </div>
      </div>
    </div>
  )
}
