'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'

/**
 * Blog search input. Submits to the listing page as `/blog?q=…`, which the
 * server component reads and passes to the backend's title/excerpt search.
 * Used both at the top of the listing and in the article sidebar.
 */
export function BlogSearchBox({ initial = '', placeholder = 'Search articles…' }: { initial?: string; placeholder?: string }) {
  const router = useRouter()
  const [q, setQ] = useState(initial)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = q.trim()
    router.push(trimmed ? `/blog?q=${encodeURIComponent(trimmed)}` : '/blog')
  }

  return (
    <form onSubmit={submit} className="relative">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label="Search articles"
        className="w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </form>
  )
}
