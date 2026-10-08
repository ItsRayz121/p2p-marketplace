'use client'
import Link from 'next/link'
import { cn } from '@/lib/utils'

const TABS = [
  { key: 'usdt', label: 'USDT Marketplace', href: '/admin/disputes' },
  { key: 'ctm', label: 'CTM Marketplace', href: '/admin/ctm/disputes' },
] as const

/** Switches between the two marketplace dispute pages (separate workflows, shared layout). */
export function DisputeMarketTabs({ active, counts }: { active: 'usdt' | 'ctm'; counts?: Partial<Record<'usdt' | 'ctm', number>> }) {
  return (
    <nav aria-label="Marketplace" className="inline-flex rounded-xl border border-border bg-surface p-1 gap-1">
      {TABS.map((t) => {
        const n = counts?.[t.key]
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active === t.key ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors',
              active === t.key ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface-alt',
            )}
          >
            {t.label}
            {n != null && n > 0 && (
              <span className={cn('min-w-[18px] rounded-full px-1.5 text-[11px] font-bold leading-[18px] text-center', active === t.key ? 'bg-white/25' : 'bg-danger text-white')}>{n}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
