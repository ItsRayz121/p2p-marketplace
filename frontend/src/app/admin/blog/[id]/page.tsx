'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { blogApi, type BlogPost, ApiError } from '@/lib/api'
import { BlogPostForm } from '@/components/blog/BlogPostForm'

export default function AdminBlogEditPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [post, setPost] = useState<BlogPost | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let active = true
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const p = await blogApi.adminGet(id)
        if (active) setPost(p)
      } catch (err) {
        if (active) setError(err instanceof ApiError ? err.message : 'Failed to load post')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [id])

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5">
        <Link href="/admin/blog" className="text-sm text-text-muted hover:text-primary">← Back to Blog</Link>
        <h1 className="text-2xl font-bold text-text-primary mt-1">Edit Post</h1>
      </div>
      {loading ? (
        <div className="py-16 text-center text-text-muted text-sm">Loading…</div>
      ) : error ? (
        <div className="py-16 text-center text-rose-500 text-sm">{error}</div>
      ) : post ? (
        <BlogPostForm initial={post} />
      ) : null}
    </div>
  )
}
