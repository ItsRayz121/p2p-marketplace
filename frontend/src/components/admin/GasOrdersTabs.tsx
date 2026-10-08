import Link from 'next/link'
import { cn } from '@/lib/utils'

const TABS = [
  { key: 'payments', label: 'Payment Orders', href: '/admin/payment-orders' },
  { key: 'trades', label: 'Gas Trades', href: '/admin/gas/trades' },
] as const

/** Shared two-tab header: payment review queue and the full gas-trade ledger. */
export function GasOrdersTabs({ active }: { active: 'payments' | 'trades' }) {
  return (
    <nav aria-label="Gas orders sections" className="flex gap-1 border-b border-border">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
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
  )
}
