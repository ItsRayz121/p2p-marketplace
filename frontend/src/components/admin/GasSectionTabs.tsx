'use client'
import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Shared sub-navigation for the consolidated Gas "Wallet Activity" section.
 * Wallet Activity is primary; Analytics lives alongside it as a tab so the two
 * read as one section (Phase 5).
 */
const TABS = [
  { key: 'activity',  label: 'Wallet Activity', href: '/admin/gas/wallet-activity' },
  { key: 'analytics', label: 'Analytics',       href: '/admin/gas/analytics' },
] as const

export function GasSectionTabs({ active }: { active: 'activity' | 'analytics' }) {
  return (
    <div className="flex items-center gap-1 border-b border-border">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            'px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors',
            active === t.key
              ? 'border-primary text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary',
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  )
}
