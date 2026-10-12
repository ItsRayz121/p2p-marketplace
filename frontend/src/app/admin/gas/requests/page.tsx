'use client'
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { adminApi, type GasCustomRequest } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { useLiveData } from '@/hooks/useLiveData'
import { useUrlParams } from '@/hooks/useGasRange'
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

type StatusFilter = 'all' | GasCustomRequest['status']
const FILTERS: StatusFilter[] = ['all', 'pending', 'reviewing', 'completed', 'rejected']
const isFilter = (v: string | null): v is StatusFilter => !!v && (FILTERS as string[]).includes(v)
const LIMIT = 20

function GasRequestsInner() {
  // The selected tab lives in the URL so it survives refresh and back/forward navigation.
  const url = useUrlParams()
  const rawStatus = url.get('status')
  const statusFilter: StatusFilter = isFilter(rawStatus) ? rawStatus : 'all'
  const [pageState, setPageState] = useState({ key: statusFilter, page: 1 })
  const page = pageState.key === statusFilter ? pageState.page : 1
  const setPage = (p: number | ((n: number) => number)) =>
    setPageState({ key: statusFilter, page: typeof p === 'function' ? p(page) : p })
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  // The status filter is applied by the server BEFORE pagination, and the key changes with
  // the tab/page, so a tab switch always refetches (and discards any older in-flight response).
  const q = useLiveData(() => {
    const params: Record<string, string | number | undefined> = { page, limit: LIMIT }
    if (statusFilter !== 'all') params.status = statusFilter
    return adminApi.getGasCustomRequests(params)
  }, `requests|${statusFilter}|${page}`, 60_000)

  const data = q.data
  const requests = data?.requests ?? []
  const counts = data?.counts
  const total = data?.pagination.total ?? 0
  const totalPages = data?.pagination.totalPages ?? 1

  // A status change on the last item of the last page can leave the current page empty.
  useEffect(() => {
    if (data && data.requests.length === 0 && page > 1) setPageState({ key: statusFilter, page: Math.max(1, data.pagination.totalPages) })
  }, [data, page, statusFilter])

  function selectTab(s: StatusFilter) {
    if (s === statusFilter) return
    url.set({ status: s === 'all' ? null : s })
  }

  async function handleStatusChange(id: string, status: GasCustomRequest['status'], adminNotes?: string) {
    setActionErr(null)
    try {
      await adminApi.updateGasCustomRequest(id, { status, adminNotes })
    } catch (err) {
      // Nothing was changed locally, so the card and counts keep their original state.
      setActionErr(`Couldn't update the request: ${err instanceof Error ? err.message : 'unknown error'}`)
      return
    }
    setActionMsg(`Request updated to ${STATUS_LABELS[status]}.`)
    setTimeout(() => setActionMsg(null), 3000)
    // Reconcile list and counts right away: a request that no longer matches this tab disappears.
    await q.refresh()
  }

  const label = statusFilter === 'all' ? 'All' : STATUS_LABELS[statusFilter]

  if (q.error && !data) return <ErrorState title={q.error} onRetry={() => { void q.refresh() }} />

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Custom Gas Requests</h1>
          <p className="text-text-muted text-sm mt-0.5" aria-live="polite">
            {!data ? 'Loading…' : statusFilter === 'all'
              ? `${total} total · User-submitted requests for unsupported blockchains`
              : `${total} ${label.toLowerCase()} of ${counts?.all ?? total} total · User-submitted requests for unsupported blockchains`}
          </p>
        </div>
        <Link href="/admin/gas">
          <Button size="sm" variant="secondary">← Gas Operations</Button>
        </Link>
      </div>

      {actionMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{actionMsg}</div>
      )}
      {actionErr && (
        <div role="alert" className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{actionErr}</div>
      )}
      {q.stale && (
        <div className="px-4 py-2 bg-warning/10 border border-warning/20 rounded-xl text-warning text-xs">
          Couldn&apos;t refresh just now — showing the last loaded results. {q.error}
        </div>
      )}

      {/* Status filter tabs, each with its count over the full dataset */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border admin-toolbar gap-2" role="group" aria-label="Filter by status">
        {FILTERS.map((s) => (
          <button key={s} type="button" onClick={() => selectTab(s)} aria-pressed={statusFilter === s}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-alt'
            }`}>
            {s === 'all' ? 'All' : STATUS_LABELS[s]}
            {counts && <span className={`ml-1.5 tabular-nums ${statusFilter === s ? 'text-white/80' : 'text-text-muted'}`}>{counts[s]}</span>}
          </button>
        ))}
      </div>

      {/* Cards */}
      {!data ? (
        <LoadingState message="Loading custom requests..." />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Fuel}
          title={statusFilter === 'all' ? 'No requests yet' : `No ${label.toLowerCase()} requests`}
          description={statusFilter === 'all' ? 'Custom gas requests from users will appear here.' : `There are no requests with the status “${label}”.`}
        />
      ) : (
        <div className="space-y-3">
          {requests.map(req => (
            <RequestCard key={req.id} req={req} onStatusChange={handleStatusChange} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3">
          <p className="text-text-muted text-sm">Page {page} of {totalPages} · {total} {statusFilter === 'all' ? '' : `${label.toLowerCase()} `}requests</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function GasRequestsPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading custom requests..." />}>
      <GasRequestsInner />
    </Suspense>
  )
}
