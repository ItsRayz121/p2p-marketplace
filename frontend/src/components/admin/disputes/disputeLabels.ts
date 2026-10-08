import type { BadgeVariant } from '@/components/ui/Badge'

/**
 * Dispute-status vocabulary shared by both marketplaces. A dispute's status and its
 * trade's status are DIFFERENT things: a trade can complete after a dispute was
 * opened (the parties settle it themselves) and the dispute still exists, closed.
 */

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** Human label for the dispute itself (never the trade). */
export function disputeOutcomeLabel(status: string, resolutionType: string | null, winner?: string | null): string {
  if (status !== 'resolved') {
    return status === 'escalated' ? 'Escalated' : status === 'awaiting_evidence' ? 'Awaiting evidence' : status === 'under_review' ? 'Under review' : 'Open'
  }
  switch (resolutionType) {
    case 'buyer_wins': return 'Resolved — buyer'
    case 'seller_wins': return 'Resolved — seller'
    case 'split': return 'Resolved — split'
    case 'settled_by_parties': return 'Closed — settled by parties'
    case 'dismissed': return 'Closed — dismissed'
    default: return winner ? `Resolved — ${winner}` : 'Resolved'
  }
}

export function disputeOutcomeVariant(status: string, resolutionType: string | null): BadgeVariant {
  if (status === 'escalated') return 'danger'
  if (status !== 'resolved') return status === 'open' ? 'warning' : 'info'
  return resolutionType === 'settled_by_parties' || resolutionType === 'dismissed' ? 'default' : 'success'
}

export const tradeStatusLabel = (s: string) => titleCase(s)

export function tradeStatusVariant(s: string): BadgeVariant {
  if (s === 'completed' || s === 'crypto_released') return 'success'
  if (s === 'disputed') return 'danger'
  if (s === 'cancelled' || s === 'expired' || s === 'refunded') return 'default'
  return 'info'
}

/** Elapsed time between two instants as "3d 4h" / "5h 12m" (freezes at `end` for closed cases). */
export function elapsed(from: string, end?: string | null): string {
  const ms = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(from).getTime())
  const h = Math.floor(ms / 3_600_000)
  const d = Math.floor(h / 24)
  return d >= 1 ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}
