import Link from 'next/link'
import { ArrowLeft, Home } from 'lucide-react'

/** Static (server-renderable) back/home nav for public info pages. */
export function StaticPageNav({ backHref = '/' }: { backHref?: string }) {
  return (
    <div className="flex items-center gap-3 mb-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={15} />
        Back
      </Link>
      <span className="text-border">·</span>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <Home size={15} />
        Home
      </Link>
    </div>
  )
}
