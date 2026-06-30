'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Eye } from 'lucide-react'
import { blogApi, type BlogPost, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function AdminBlogListPage() {
  const [posts, setPosts] = useState<BlogPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft'>('all')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await blogApi.adminList({ status: statusFilter, pageSize: 100 })
      setPosts(res.posts)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load posts')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { void load() }, [load])

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return
    try {
      await blogApi.adminDelete(id)
      setPosts((p) => p.filter((x) => x.id !== id))
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Blog</h1>
          <p className="text-sm text-text-muted">Write and publish articles to drive search traffic.</p>
        </div>
        <Link href="/admin/blog/new" className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold hover:bg-primary-hover">
          + New Post
        </Link>
      </div>

      <div className="admin-toolbar flex items-center gap-2 mb-4">
        {(['all', 'published', 'draft'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-colors',
              statusFilter === s ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt border border-border',
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-16 text-center text-text-muted text-sm">Loading…</div>
      ) : error ? (
        <div className="py-16 text-center text-rose-500 text-sm">{error}</div>
      ) : posts.length === 0 ? (
        <div className="py-16 text-center text-text-muted">
          <p className="text-sm">No posts yet.</p>
          <Link href="/admin/blog/new" className="text-primary text-sm font-semibold hover:underline">Write your first article →</Link>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl overflow-hidden divide-y divide-border">
          {posts.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-alt/50">
              {p.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.coverImageUrl} alt="" className="w-12 h-12 rounded-md object-cover border border-border shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-md bg-surface-alt border border-border shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-primary truncate">{p.title}</p>
                <p className="text-xs text-text-muted truncate">/{p.slug}</p>
              </div>
              <span className={cn('text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0', p.status === 'published' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
                {p.status}
              </span>
              <span className="hidden sm:block text-xs text-text-muted w-20 text-right shrink-0">{p.viewCount} views</span>
              <div className="flex items-center gap-2 shrink-0">
                {p.status === 'published' && (
                  <a
                    href={`/blog/${p.slug}`}
                    target="_blank"
                    rel="noopener"
                    title="View live post"
                    aria-label="View live post"
                    className="text-text-muted hover:text-primary p-1"
                  >
                    <Eye size={16} />
                  </a>
                )}
                <Link href={`/admin/blog/${p.id}`} className="text-xs font-semibold text-primary hover:underline">Edit</Link>
                <button onClick={() => remove(p.id, p.title)} className="text-xs font-semibold text-rose-500 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
