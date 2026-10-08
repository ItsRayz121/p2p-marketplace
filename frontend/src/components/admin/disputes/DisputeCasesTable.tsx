'use client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { fmtDate } from '@/lib/fmt'
import type { DisputeOverviewRow } from '@/lib/api'
import { disputeOutcomeLabel, disputeOutcomeVariant, elapsed, tradeStatusLabel, tradeStatusVariant } from './disputeLabels'

/** Shared case list for both marketplaces. Dispute status and trade status are separate columns. */
export function DisputeCasesTable({
  rows,
  onReview,
}: {
  rows: DisputeOverviewRow[]
  onReview: (row: DisputeOverviewRow) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface">
            <tr className="text-left text-xs font-medium text-text-muted">
              <th className="px-4 py-3">Case / Trade</th>
              <th className="px-4 py-3">Buyer</th>
              <th className="px-4 py-3">Seller</th>
              <th className="px-4 py-3">Dispute status</th>
              <th className="px-4 py-3">Trade status</th>
              <th className="px-4 py-3">Opened</th>
              <th className="px-4 py-3">Resolved</th>
              <th className="px-4 py-3">Reviewer</th>
              <th className="px-4 py-3 text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const closed = r.disputeStatus === 'resolved'
              return (
                <tr key={r.id} className="hover:bg-surface-alt/40 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-mono text-xs font-semibold text-text-primary" title={r.tradeRef}>{r.tradeRef}</p>
                    <p className="text-[11px] text-text-muted">{r.reason.replace(/_/g, ' ')} · {r.evidenceCount} msg{r.evidenceCount === 1 ? '' : 's'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-text-primary">{r.buyer.username ?? '—'}</p>
                    <p className="text-[11px] text-text-muted">{r.buyer.stats.total} dispute{r.buyer.stats.total === 1 ? '' : 's'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-text-primary">{r.seller.username ?? '—'}</p>
                    <p className="text-[11px] text-text-muted">{r.seller.stats.total} dispute{r.seller.stats.total === 1 ? '' : 's'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={disputeOutcomeVariant(r.disputeStatus, r.resolutionType)} size="sm">
                      {disputeOutcomeLabel(r.disputeStatus, r.resolutionType, r.winner)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={tradeStatusVariant(r.tradeStatus)} size="sm">{tradeStatusLabel(r.tradeStatus)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {fmtDate(r.createdAt)}
                    {/* The clock stops when the case is resolved — it is the time the case took, not time since. */}
                    <p className="text-[11px] text-text-muted">{closed ? `took ${elapsed(r.createdAt, r.resolvedAt)}` : `${elapsed(r.createdAt)} open`}</p>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{fmtDate(r.resolvedAt)}</td>
                  <td className="px-4 py-3 text-text-secondary">{r.reviewer ?? <span className="text-text-muted">—</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant={closed ? 'ghost' : 'primary'} onClick={() => onReview(r)}>
                      {closed ? 'View' : 'Review'}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
