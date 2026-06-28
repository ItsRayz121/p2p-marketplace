'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, LayoutDashboard, Home } from 'lucide-react'
import { useAuthStore } from '@/store/auth.store'
import { goBackSafe } from '@/lib/nav'

interface PageBackNavProps {
  /** Override the back destination. Default: browser history. */
  backHref?: string
  /** Override the dashboard destination. Default: /dashboard. */
  dashboardHref?: string
}

export function PageBackNav({ backHref, dashboardHref = '/dashboard' }: PageBackNavProps) {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)

  function handleBack() {
    if (backHref) router.push(backHref)
    else goBackSafe(router, dashboardHref)
  }

  return (
    <div className="flex items-center gap-3 mb-6">
      <button
        onClick={handleBack}
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={15} />
        Back
      </button>
      <span className="text-border">·</span>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <Home size={15} />
        Home
      </Link>
      {user && (
        <>
          <span className="text-border">·</span>
          <Link
            href={dashboardHref}
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
          >
            <LayoutDashboard size={15} />
            Dashboard
          </Link>
        </>
      )}
    </div>
  )
}
