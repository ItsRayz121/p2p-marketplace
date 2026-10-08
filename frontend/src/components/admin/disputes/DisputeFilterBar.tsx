'use client'
import { cn } from '@/lib/utils'
import type { DisputeFilter } from '@/lib/api'

export const DISPUTE_FILTERS: { key: DisputeFilter; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Every dispute ever opened, whatever the outcome' },
  { key: 'open', label: 'Open', hint: 'Awaiting review or more evidence' },
  { key: 'escalated', label: 'Escalated', hint: 'Needs senior review' },
  { key: 'resolved', label: 'Resolved', hint: 'An admin ruled on the case' },
  { key: 'closed', label: 'Closed', hint: 'Closed with no ruling — settled by the parties or dismissed' },
]

export function DisputeFilterBar({
  value,
  counts,
  onChange,
}: {
  value: DisputeFilter
  counts?: Partial<Record<DisputeFilter, number>>
  onChange: (f: DisputeFilter) => void
}) {
  return (
    <div role="group" aria-label="Dispute status" className="flex flex-wrap gap-2">
      {DISPUTE_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          title={f.hint}
          aria-pressed={value === f.key}
          onClick={() => onChange(f.key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            value === f.key ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt',
          )}
        >
          {f.label}
          {counts?.[f.key] != null && (
            <span className={cn('rounded-full px-1.5 text-xs tabular-nums', value === f.key ? 'bg-white/25' : 'bg-surface-alt text-text-muted')}>{counts[f.key]}</span>
          )}
        </button>
      ))}
    </div>
  )
}
