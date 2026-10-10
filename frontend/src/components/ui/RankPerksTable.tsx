'use client'
import { useEffect, useState } from 'react'
import { apiRequest } from '@/lib/api'

interface RankPerk {
  badge: string
  rankLabel: string
  gasDiscountPct: number
  pointsBonusPct: number
  listingPriority: boolean
}

/** Live rank perks (admin-tuned). Renders nothing until loaded, and nothing if no rank has a perk. */
export function RankPerksTable() {
  const [ladder, setLadder] = useState<RankPerk[] | null>(null)

  useEffect(() => {
    let alive = true
    apiRequest<{ ladder: RankPerk[] }>('/users/rank-perks')
      .then((r) => { if (alive) setLadder(r.ladder) })
      .catch(() => { /* perks are informational; stay hidden on error */ })
    return () => { alive = false }
  }, [])

  const rows = (ladder ?? []).filter((p) => p.gasDiscountPct > 0 || p.pointsBonusPct > 0 || p.listingPriority)
  if (rows.length === 0) return null

  return (
    <div className="space-y-3">
      <h3 className="text-base font-bold text-text-primary">Rank perks</h3>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full">
          <thead className="bg-surface-alt border-b border-border">
            <tr>
              <th className="text-left text-xs font-semibold text-text-muted px-3 py-2">Rank</th>
              <th className="text-left text-xs font-semibold text-text-muted px-3 py-2">Gas fee discount</th>
              <th className="text-left text-xs font-semibold text-text-muted px-3 py-2">Points earning</th>
              <th className="text-left text-xs font-semibold text-text-muted px-3 py-2">Ad listing</th>
            </tr>
          </thead>
          <tbody className="bg-surface divide-y divide-border">
            {rows.map((p) => (
              <tr key={p.badge}>
                <td className="px-3 py-2 text-sm font-semibold text-text-primary">{p.rankLabel}</td>
                <td className="px-3 py-2 text-sm text-text-secondary">{p.gasDiscountPct > 0 ? `${p.gasDiscountPct}% off our margin` : '—'}</td>
                <td className="px-3 py-2 text-sm text-text-secondary">{p.pointsBonusPct > 0 ? `+${p.pointsBonusPct}% on trades & gas orders` : '—'}</td>
                <td className="px-3 py-2 text-sm text-text-secondary">{p.listingPriority ? 'Priority placement' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted">
        The gas discount does not stack with other loyalty offers: the single best one applies. Daily points caps still apply.
      </p>
    </div>
  )
}
