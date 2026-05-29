'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi, type GasCustomRequest } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Fuel } from 'lucide-react'
import { Button } from '@/components/ui/Button'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<GasCustomRequest['status'], string> = {
  pending:   'Pending',
  reviewing: 'Reviewing',
  completed: 'Completed',
  rejected:  'Rejected',
}

function statusVariant(s: GasCustomRequest['status']): 'warning' | 'default' | 'success' | 'danger' {
  if (s === 'pending')   return 'warning'
  if (s === 'reviewing') return 'default'
  if (s === 'completed') return 'success'
  return 'danger'
}

const URGENCY_LABELS: Record<string, string> = { low: 'Low', normal: 'Normal', urgent: 'Urgent' }

// ─── Detail Row ───────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border last:border-0">
      <span className="w-32 shrink-0 text-xs text-text-muted font-medium">{label}</span>
      <span className="text-xs text-text-primary break-words flex-1">{value}</span>
    </div>
  )
}

// ─── Request Card ─────────────────────────────────────────────────────────────

function RequestCard({
  req, onStatusChange,
}: {
  req: GasCustomRequest
  onStatusChange: (id: string, status: GasCustomRequest['status'], notes?: string) => void
}) {
  const [expanded, setExpanded]   = useState(false)
  const [notes, setNotes]         = useState(req.adminNotes ?? '')
  const [saving, setSaving]       = useState(false)

  async function save(status: GasCustomRequest['status']) {
    setSaving(true)
    try { await onStatusChange(req.id, status, notes) }
    finally { setSaving(false) }
  }

  return (
    <div className={`bg-surface shadow-card border rounded-xl overflow-hidden transition-all ${
      req.status === 'pending' ? 'border-warning/40' : 'border-border'
    }`}>
      {/* Summary row */}
      <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-text-primary">{req.blockchainName}</span>
            <span className="text-xs text-text-muted">·</span>
            <span className="text-xs text-text-secondary">{req.token}</span>
            {req.amount && <span className="text-xs text-text-muted">· {req.amount}</span>}
            <Badge variant={req.urgency === 'urgent' ? 'danger' : req.urgency === 'normal' ? 'default' : 'outline'} size="sm">
              {URGENCY_LABELS[req.urgency] ?? req.urgency}
            </Badge>
          </div>
          <p className="text-xs text-text-muted mt-0.5">{req.purpose.replace('_', ' ')} · {fmtDate(req.createdAt)}</p>
        </div>
        <Badge variant={statusVariant(req.status)} size="sm">{STATUS_LABELS[req.status]}</Badge>
        <svg className={`w-4 h-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-5 py-4 space-y-4">
          <div className="bg-surface rounded-xl p-4">
            <DetailRow label="Blockchain"  value={req.blockchainName} />
            <DetailRow label="Token"       value={req.token} />
            <DetailRow label="Amount"      value={req.amount} />
            <DetailRow label="Purpose"     value={req.purpose.replace('_', ' ')} />
            <DetailRow label="Urgency"     value={URGENCY_LABELS[req.urgency] ?? req.urgency} />
            <DetailRow label="Details"     value={req.details} />
            <DetailRow label="Contact"     value={req.contactEmail} />
            <DetailRow label="IP Address"  value={req.ipAddress} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-text-muted mb-1.5">Admin Notes</label>
            <textarea
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal notes about this request..."
              className="w-full px-3 py-2 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {req.status === 'pending' && (
              <Button size="sm" variant="primary" disabled={saving} onClick={() => save('reviewing')}>
                Start Reviewing
              </Button>
            )}
            {req.status !== 'completed' && req.status !== 'rejected' && (
              <Button size="sm" variant="primary" disabled={saving} onClick={() => save('completed')}>
                Mark Completed
              </Button>
            )}
            {req.status !== 'rejected' && (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => save('rejected')}>
                Reject
              </Button>
            )}
            {req.status !== 'pending' && req.status !== 'reviewing' && (
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => save('pending')}>
                Reopen
              </Button>
            )}
            {notes !== (req.adminNotes ?? '') && (
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => save(req.status)}>
                Save Notes
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasRequestsPage() {
  const [requests, setRequests] = useState<GasCustomRequest[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [page, setPage]         = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const limit = 20

  const fetchRequests = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getGasCustomRequests(params)
      setRequests(data.requests)
      setTotal(data.pagination.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchRequests, 60_000)

  async function handleStatusChange(id: string, status: GasCustomRequest['status'], adminNotes?: string) {
    await adminApi.updateGasCustomRequest(id, { status, adminNotes })
    setActionMsg(`Request updated to ${STATUS_LABELS[status]}.`)
    setTimeout(() => setActionMsg(null), 3000)
    void fetchRequests()
  }

  const totalPages = Math.ceil(total / limit)
  if (loading) return <LoadingState message="Loading custom requests..." />
  if (error && requests.length === 0) return <ErrorState title={error} onRetry={fetchRequests} />

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Custom Gas Requests</h1>
          <p className="text-text-muted text-sm mt-0.5">{total} total · User-submitted requests for unsupported blockchains</p>
        </div>
        <Link href="/admin/gas">
          <Button size="sm" variant="secondary">← Gas Operations</Button>
        </Link>
      </div>

      {actionMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{actionMsg}</div>
      )}

      {/* Status filter tabs */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-2">
        {(['all', 'pending', 'reviewing', 'completed', 'rejected'] as const).map((s) => (
          <button key={s} onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
              statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:bg-surface'
            }`}>
            {s === 'all' ? 'All' : STATUS_LABELS[s as GasCustomRequest['status']]}
          </button>
        ))}
      </div>

      {/* Cards */}
      {requests.length === 0 ? (
        <EmptyState icon={Fuel} title="No requests found" description="No custom gas fee requests match the current filter." />
      ) : (
        <div className="space-y-3">
          {requests.map(req => (
            <RequestCard key={req.id} req={req} onStatusChange={handleStatusChange} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between bg-white border border-border rounded-xl px-4 py-3">
          <p className="text-text-muted text-sm">Page {page} of {totalPages} · {total} requests</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  )
}
