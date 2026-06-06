'use client'
import { useCallback, useEffect, useState } from 'react'
import { walletApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Badge } from '@/components/ui/Badge'

interface DepositRow {
  id: string
  chain: string
  chainName: string
  symbol: string
  amount: string
  confirmations: number
  minConfirmations: number
  progress: number | null
  status: 'detected' | 'credited' | 'rejected'
  rejectionReason: string | null
  txHash: string
  explorerUrl?: string
  detectedAt: string
  creditedAt: string | null
}

function shortHash(h: string): string {
  return h.slice(0, 10) + '…' + h.slice(-6)
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(iso).toLocaleDateString()
}

function ConfirmationBar({ row }: { row: DepositRow }) {
  if (row.status === 'credited') {
    return (
      <div className="flex items-center gap-2 text-xs text-success">
        <span>✓</span>
        <span>Credited {row.creditedAt ? timeAgo(row.creditedAt) : ''}</span>
      </div>
    )
  }
  if (row.status === 'rejected') {
    return (
      <div className="text-xs text-danger">
        Rejected{row.rejectionReason ? ` — ${row.rejectionReason}` : ''}
      </div>
    )
  }
  // Detected — show progress to confirmations threshold
  const pct = Math.round((row.progress ?? 0) * 100)
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-text-muted">
        <span>Awaiting confirmations</span>
        <span>{row.confirmations} / {row.minConfirmations}</span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function RecentDeposits() {
  const [rows, setRows] = useState<DepositRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDeposits = useCallback(async () => {
    try {
      const res = await walletApi.getRecentDeposits()
      setRows(res.deposits)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deposits')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDeposits() }, [fetchDeposits])
  // Poll while any deposit is still in detected state — gives near-real-time
  // confirmation progress without smashing the API for users with nothing in
  // flight.
  const hasPending = rows.some((r) => r.status === 'detected')
  usePolling(fetchDeposits, hasPending ? 8_000 : 60_000, !loading)

  if (loading) return null
  if (error) {
    return <p className="text-xs text-danger">Couldn&apos;t load recent deposits: {error}</p>
  }
  if (rows.length === 0) return null

  return (
    <section>
      <h2 className="text-base font-semibold text-text-primary mb-1">Recent deposits</h2>
      <p className="text-xs text-text-muted mb-3">
        On-chain transfers to your RupChain addresses. Pending rows update as new blocks confirm.
      </p>
      <div className="bg-surface rounded-xl border border-border overflow-hidden divide-y divide-border">
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-3 space-y-2">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="font-bold text-text-primary">
                  {parseFloat(r.amount).toFixed(6).replace(/\.?0+$/, '')} {r.symbol}
                </span>
                <Badge size="sm" variant={
                  r.status === 'credited' ? 'success'
                    : r.status === 'rejected' ? 'danger'
                    : 'warning'
                }>
                  {r.status === 'detected' ? 'Pending' : r.status === 'credited' ? 'Credited' : 'Rejected'}
                </Badge>
              </div>
              <div className="text-xs text-text-muted">
                {r.chainName} · {timeAgo(r.detectedAt)}
              </div>
            </div>
            <ConfirmationBar row={r} />
            {r.explorerUrl && (
              <div className="text-xs">
                <a
                  href={r.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline font-mono"
                >
                  {shortHash(r.txHash)} ↗
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
