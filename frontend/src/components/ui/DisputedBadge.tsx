import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Public "Disputed" marker for a trader who has an open dispute against them or
 * is on a trading hold. It deliberately says only that a dispute is open — never
 * "scam" — so a false claim cannot brand an honest trader.
 */
export function DisputedBadge({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span
      title="This trader has an open dispute. Trade with care until it is resolved."
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-danger/10 text-danger border border-danger/20 font-medium whitespace-nowrap',
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        className,
      )}
    >
      <AlertTriangle className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      Disputed
    </span>
  )
}
