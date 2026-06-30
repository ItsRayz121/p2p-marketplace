'use client'

import Link from 'next/link'
import { BlogPostForm } from '@/components/blog/BlogPostForm'

export default function AdminBlogNewPage() {
  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5">
        <Link href="/admin/blog" className="text-sm text-text-muted hover:text-primary">← Back to Blog</Link>
        <h1 className="text-2xl font-bold text-text-primary mt-1">New Post</h1>
      </div>
      <BlogPostForm />
    </div>
  )
}
