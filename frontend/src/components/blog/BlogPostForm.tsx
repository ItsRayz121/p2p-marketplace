'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { blogApi, type BlogPost, type BlogUpsert, ApiError } from '@/lib/api'
import { useFileUpload } from '@/hooks/useFileUpload'
import { BlogEditor } from './BlogEditor'
import { cn } from '@/lib/utils'

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
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '))
  const [category, setCategory] = useState(initial?.category ?? '')
  const [metaTitle, setMetaTitle] = useState(initial?.metaTitle ?? '')
  const [metaDescription, setMetaDescription] = useState(initial?.metaDescription ?? '')
  const [focusKeyword, setFocusKeyword] = useState(initial?.focusKeyword ?? '')
  const [noindex, setNoindex] = useState(initial?.noindex ?? false)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

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
      status,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      category: category.trim() || null,
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
        await blogApi.adminUpdate(initial.id, payload)
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
    <div className="grid lg:grid-cols-3 gap-6">
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

      {/* Sidebar */}
      <div className="space-y-5">
        {/* Publish box */}
        <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-text-primary">Publish</span>
            {initial && (
              <span className={cn('text-[11px] font-semibold px-2 py-0.5 rounded-full', initial.status === 'published' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
                {initial.status}
              </span>
            )}
          </div>
          {error && <p className="text-xs text-rose-500">{error}</p>}
          {ok && <p className="text-xs text-success">{ok}</p>}
          <div className="flex gap-2">
            <button onClick={() => save('draft')} disabled={saving} className="flex-1 px-3 py-2 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-alt disabled:opacity-50">
              Save draft
            </button>
            <button onClick={() => save('published')} disabled={saving} className="flex-1 px-3 py-2 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary-hover disabled:opacity-50">
              {saving ? 'Saving…' : 'Publish'}
            </button>
          </div>
          {initial?.status === 'published' && (
            <a href={`/blog/${initial.slug}`} target="_blank" rel="noopener" className="block text-center text-xs text-primary hover:underline">View live post ↗</a>
          )}
        </div>

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
              <input className={inputCls} value={coverImageAlt} onChange={(e) => setCoverImageAlt(e.target.value)} placeholder="Cover alt text (SEO)" />
              <button onClick={() => setCoverImageUrl('')} className="text-xs text-rose-500 hover:underline">Remove cover</button>
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
            <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Guides" />
          </div>
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
  )
}
