'use client'

import { useEffect, useState } from 'react'
import { Eye, X } from 'lucide-react'
import {
  BlogArticlePreview,
  BLOG_PREVIEW_CHANNEL,
  BLOG_PREVIEW_STORAGE_KEY,
  type BlogPreviewSnapshot,
} from '@/components/blog/BlogArticlePreview'

// Full-screen live preview opened in its own tab from the blog editor. It holds
// no state of its own — it renders whatever snapshot the editor last broadcast
// (via BroadcastChannel, with a localStorage seed for the first paint and a
// `storage`-event fallback for browsers without BroadcastChannel). Rendered as a
// fixed overlay so it covers the admin chrome for a clean, public-like view.
export default function BlogPreviewPage() {
  const [snap, setSnap] = useState<BlogPreviewSnapshot | null>(null)

  useEffect(() => {
    // Seed from the snapshot the editor wrote just before opening this tab.
    try {
      const raw = localStorage.getItem(BLOG_PREVIEW_STORAGE_KEY)
      if (raw) setSnap(JSON.parse(raw) as BlogPreviewSnapshot)
    } catch { /* ignore malformed snapshot */ }

    // Live updates while the editor tab is open.
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(BLOG_PREVIEW_CHANNEL)
      channel.onmessage = (e) => { if (e.data) setSnap(e.data as BlogPreviewSnapshot) }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === BLOG_PREVIEW_STORAGE_KEY && e.newValue) {
        try { setSnap(JSON.parse(e.newValue) as BlogPreviewSnapshot) } catch { /* ignore */ }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => { channel?.close(); window.removeEventListener('storage', onStorage) }
  }, [])

  return (
    <div className="fixed inset-0 z-[100] bg-canvas overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-surface/95 backdrop-blur px-5 py-3">
        <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
          <Eye size={14} aria-hidden /> Live preview — updates as you edit
        </span>
        <button onClick={() => window.close()} className="inline-flex items-center gap-1 text-sm font-semibold text-text-secondary hover:text-text-primary">
          <X size={16} aria-hidden /> Close
        </button>
      </div>
      <div className="mx-auto w-full max-w-3xl">
        {snap ? (
          <BlogArticlePreview snapshot={snap} />
        ) : (
          <p className="p-8 text-text-muted">
            Open this preview from the blog editor’s <span className="font-semibold">Preview</span> button — it updates live as you type.
          </p>
        )}
      </div>
    </div>
  )
}
