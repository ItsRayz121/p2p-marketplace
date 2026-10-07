'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi, type ScammerListRow } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ShieldAlert } from 'lucide-react'

type Filter = 'all' | 'hold' | 'disputes'

export default function ScammerListPage() {
  const [rows, setRows] = useState<ScammerListRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    try {
      setRows(await adminApi.getScammerList())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the list')
    }
  }, [])

  usePolling(load, 60_000)

  if (error && !rows) return <ErrorState title={error} onRetry={load} />
  if (!rows) return <LoadingState message="Loading scammer list..." />

  const shown = rows.filter((r) => filter === 'all' || (filter === 'hold' ? r.tradingHold : r.openDisputes.length > 0))
  const heldCount = rows.filter((r) => r.tradingHold).length

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-danger" /> Scammer List</h1>
        <p className="text-sm text-text-muted mt-1">
          Accounts on a trading hold, plus accounts with an open dispute against them. Open a user to apply or release a hold.
        </p>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {([
          ['all', `All (${rows.length})`],
          ['hold', `On hold (${heldCount})`],
          ['disputes', `Open disputes (${rows.filter((r) => r.openDisputes.length > 0).length})`],
        ] as Array<[Filter, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${filter === key ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:border-primary/40'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nothing here" description="No accounts match this filter." />
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => (
            <li key={r.id} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/admin/users/${r.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">
                    {r.username ?? r.email}
                  </Link>
                  <p className="text-xs text-text-muted truncate">{r.email} · KYC {r.kycStatus === 'approved' ? r.kycLevel : r.kycStatus}</p>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {r.tradingHold && <Badge variant="danger" size="sm">On hold</Badge>}
                  {r.openDisputes.length > 0 && <Badge variant="warning" size="sm">{r.openDisputes.length} open dispute{r.openDisputes.length === 1 ? '' : 's'}</Badge>}
                  {r.isTrusted && <Badge variant="default" size="sm">Trusted</Badge>}
                  {r.isBanned && <Badge variant="danger" size="sm">Banned</Badge>}
                  {r.isSuspended && <Badge variant="warning" size="sm">Suspended</Badge>}
                </div>
              </div>

              {r.tradingHold && (
                <p className="text-sm text-text-secondary mt-2">
                  <strong>Hold reason:</strong> {r.tradingHoldReason || '—'}
                  {r.tradingHoldSince && <span className="text-xs text-text-muted"> · since {fmtDateTime(r.tradingHoldSince)}</span>}
                </p>
              )}

              {r.openDisputes.length > 0 && (
                <ul className="mt-2 text-xs text-text-secondary space-y-1">
                  {r.openDisputes.map((d) => (
                    <li key={`${d.market}-${d.tradeId}`} className="flex flex-wrap gap-x-2">
                      <Link
                        href={d.market === 'ctm' ? `/admin/ctm/trades/${d.tradeRef ?? d.tradeId}` : `/admin/trades/${d.tradeId}`}
                        className="text-primary hover:underline"
                      >
                        {d.market === 'ctm' ? 'CTM trade' : 'USDT trade'} {d.tradeRef ?? d.tradeId.slice(0, 8)}
                      </Link>
                      <span className="text-text-muted">opened {fmtDateTime(d.openedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
