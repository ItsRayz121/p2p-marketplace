'use client'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth.store'

export type PromoTab = 'overview' | 'promo' | 'giveaways' | 'rewards' | 'tasks'

const TABS: { key: PromoTab; label: string; href: string; superOnly?: boolean }[] = [
  { key: 'overview', label: 'Overview', href: '/admin/promotions' },
  { key: 'promo', label: 'Promo Codes', href: '/admin/gas/promo-codes' },
  { key: 'giveaways', label: 'Giveaways', href: '/admin/gas/giveaways' },
  { key: 'rewards', label: 'Gas Rewards', href: '/admin/gas/free-gas' },
  { key: 'tasks', label: 'Community Tasks', href: '/admin/tasks', superOnly: true },
]

export const GIVEAWAY_SUBTABS = [
  { label: 'Platform gas giveaways', hint: 'Platform-funded draw', href: '/admin/gas/giveaways' },
  { label: 'Community giveaways', hint: 'Creator-funded, off-platform', href: '/admin/promo-giveaways' },
]
export const REWARD_SUBTABS = [
  { label: 'Direct delivery', hint: 'Admin sends free gas', href: '/admin/gas/free-gas' },
  { label: 'Codes', hint: '100% free-gas codes', href: '/admin/gas/free-codes' },
  { label: 'Share & Earn', hint: 'Reward for a post', href: '/admin/gas/share-rewards' },
]

/**
 * Shared header for every Promotions page. The pages themselves keep their URLs and logic —
 * this only groups them, so no deep link, permission or workflow changes.
 */
export function PromotionsNav({ active, current }: { active: PromoTab; current?: string }) {
  const role = useAuthStore((s) => s.user?.role)
  const sub = active === 'giveaways' ? GIVEAWAY_SUBTABS : active === 'rewards' ? REWARD_SUBTABS : null
  return (
    <div className="space-y-3">
      <nav aria-label="Promotions sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((t) => !t.superOnly || role === 'super_admin').map((t) => (
          <Link
            key={t.key}
            href={t.key === 'rewards' && role !== 'super_admin' ? '/admin/gas/share-rewards' : t.href}
            aria-current={active === t.key ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              active === t.key ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {sub && (
        <div role="group" aria-label="Section views" className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">
          {sub
            .filter((s) => role === 'super_admin' || (s.href !== '/admin/gas/free-gas' && s.href !== '/admin/gas/free-codes'))
            .map((s) => (
              <Link
                key={s.href}
                href={s.href}
                title={s.hint}
                aria-current={current === s.href ? 'page' : undefined}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  current === s.href ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface-alt',
                )}
              >
                {s.label}
              </Link>
            ))}
        </div>
      )}
    </div>
  )
}
