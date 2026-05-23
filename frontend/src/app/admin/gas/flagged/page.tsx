'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useAuthStore } from '@/store/auth.store'
import { Modal } from '@/components/ui/Modal'

type FlaggedOrder = {
  id: string
  orderId: string
  reasons: string
  riskScore: number
  status: string
  reviewedBy: string | null
  reviewedAt: string | null
  adminNote: string | null
  createdAt: string
  order: {
    orderRef: string
    chain: string
    status: string
    toAddress: string
    gasAmountUSD: number
    paymentAmount: number
    createdAt: string
    ipAddress: string | null
  }
}

const STATUS_FILTERS = ['', 'pending_review', 'reviewed_ok', 'reviewed_blocked']

function riskColor(score: number) {
  if (score >= 80) return 'text-danger font-bold'
  if (score >= 50) return 'text-warning font-semibold'
  return 'text-text-muted'
}

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'pending_review') return 'warning'
  if (s === 'reviewed_ok') return 'success'
  if (s === 'reviewed_blocked') return 'danger'
  return 'default'
}

function parseReasons(raw: string): string[] {
  try { return JSON.parse(raw) as string[] } catch { return [raw] }
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

export default function GasFlaggedPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'

  const [items, setItems] = useState<FlaggedOrder[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const [reviewing, setReviewing] = useState<FlaggedOrder | null>(null)
  const [reviewAction, setReviewAction] = useState<'reviewed_ok' | 'reviewed_blocked'>('reviewed_ok')
  const [reviewNote, setReviewNote] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)

  const LIMIT = 20

  const fetchItems = useCallback(async (p = 1, status = statusFilter) => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.listFlaggedOrders(status || undefined, p, LIMIT)
      setItems(res.flagged)
      setTotal(res.total)
      setPage(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load flagged orders')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { fetchItems(1) }, [fetchItems])

  function flash(msg: string) {
    setSuccessMsg(msg)
    setTimeout(() => setSuccessMsg(null), 3500)
  }

  function openReview(item: FlaggedOrder) {
    setReviewing(item)
    setReviewAction('reviewed_ok')
    setReviewNote('')
  }

  async function submitReview() {
    if (!reviewing) return
    setReviewSaving(true)
    try {
      await adminApi.reviewFlaggedOrder(reviewing.id, reviewAction, reviewNote || undefined)
      flash(`Order ${reviewing.order.orderRef} marked as ${reviewAction}.`)
      setReviewing(null)
      fetchItems(page)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to submit review')
    } finally {
      setReviewSaving(false)
    }
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Flagged Orders</h1>
          <p className="text-text-muted text-sm mt-0.5">Risk-scored orders awaiting manual review.</p>
        </div>
        <select
          className="border border-border rounded-lg px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); fetchItems(1, e.target.value) }}
        >
          <option value="">All statuses</option>
          <option value="pending_review">Pending Review</option>
          <option value="reviewed_ok">Reviewed OK</option>
          <option value="reviewed_blocked">Reviewed Blocked</option>
        </select>
      </div>

      {successMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{successMsg}</div>
      )}
      {error && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{error}</div>
      )}

      {loading && <LoadingState message="Loading flagged orders..." />}
      {!loading && error && <ErrorState title={error} onRetry={() => fetchItems(1)} />}
      {!loading && !error && items.length === 0 && (
        <EmptyState title="No flagged orders" description={statusFilter ? `No orders with status "${statusFilter}".` : 'No orders have been flagged.'} />
      )}

      {!loading && items.length > 0 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Destination</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Risk Score</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Reasons</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Flagged</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-text-primary">{item.order.orderRef}</p>
                        <p className="text-xs text-text-muted">{usd(item.order.gasAmountUSD)}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="default" size="sm">{item.order.chain}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs bg-surface px-1.5 py-0.5 rounded" title={item.order.toAddress}>
                        {item.order.toAddress.slice(0, 14)}...
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span className={riskColor(item.riskScore)}>{item.riskScore}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {parseReasons(item.reasons).map((r) => (
                          <span key={r} className="px-1.5 py-0.5 bg-warning/10 text-warning text-xs rounded font-medium">{r}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(item.status)} size="sm">
                        {item.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">{fmt(item.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {item.status === 'pending_review' && isAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => openReview(item)}>Review</Button>
                      )}
                      {item.status !== 'pending_review' && item.adminNote && (
                        <span className="text-xs text-text-muted italic" title={item.adminNote}>Note</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => fetchItems(page - 1)}>Prev</Button>
          <span className="text-sm text-text-muted">Page {page} / {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => fetchItems(page + 1)}>Next</Button>
        </div>
      )}

      {/* Review Modal */}
      <Modal
        isOpen={!!reviewing}
        onClose={() => setReviewing(null)}
        title="Review Flagged Order"
        size="md"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setReviewing(null)} disabled={reviewSaving}>Cancel</Button>
            <Button className="flex-1" onClick={submitReview} disabled={reviewSaving}>
              {reviewSaving ? 'Saving...' : 'Submit Review'}
            </Button>
          </div>
        }
      >
        {reviewing && (
          <div className="space-y-4">
            <div className="bg-surface rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Order Ref</span>
                <span className="font-medium">{reviewing.order.orderRef}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Chain</span>
                <span className="font-medium">{reviewing.order.chain}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Amount</span>
                <span className="font-medium">{usd(reviewing.order.gasAmountUSD)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Risk Score</span>
                <span className={riskColor(reviewing.riskScore)}>{reviewing.riskScore} / 100</span>
              </div>
              <div>
                <span className="text-text-muted block mb-1">Reasons</span>
                <div className="flex flex-wrap gap-1">
                  {parseReasons(reviewing.reasons).map((r) => (
                    <span key={r} className="px-1.5 py-0.5 bg-warning/10 text-warning text-xs rounded font-medium">{r}</span>
                  ))}
                </div>
              </div>
              {reviewing.order.ipAddress && (
                <div className="flex justify-between">
                  <span className="text-text-muted">IP</span>
                  <code className="text-xs bg-white px-1 rounded">{reviewing.order.ipAddress}</code>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-text-muted block">Decision</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" value="reviewed_ok" checked={reviewAction === 'reviewed_ok'} onChange={() => setReviewAction('reviewed_ok')} className="accent-success" />
                  <span className="text-sm text-success font-medium">Approve (OK)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" value="reviewed_blocked" checked={reviewAction === 'reviewed_blocked'} onChange={() => setReviewAction('reviewed_blocked')} className="accent-danger" />
                  <span className="text-sm text-danger font-medium">Block</span>
                </label>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted block mb-1">Admin Note (optional)</label>
              <textarea
                className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
                rows={2}
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Internal note..."
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function usd(v: number) {
  return `$${Number(v).toFixed(2)}`
}
