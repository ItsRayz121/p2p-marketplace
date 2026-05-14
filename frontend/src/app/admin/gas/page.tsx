'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface GasOrder {
  id: string
  orderRef: string
  tier: string
  toAddress: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
  txHash?: string
  errorMessage?: string
  createdAt: string
}

interface GasOrdersResponse {
  orders: GasOrder[]
  total: number
}

const statusVariant = (s: string) => {
  if (s === 'completed') return 'success'
  if (s === 'failed') return 'danger'
  if (s === 'refunded') return 'warning'
  if (s === 'processing') return 'default'
  return 'outline'
}

export default function GasPage() {
  const [orders, setOrders] = useState<GasOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('all')

  const [confirmRetry, setConfirmRetry] = useState(false)
  const [confirmRefund, setConfirmRefund] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const limit = 20

  const fetchOrders = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getGasOrders(params) as GasOrdersResponse
      setOrders(data.orders ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gas orders')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchOrders, 30_000)

  async function handleRetry() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.retryGasOrder(selectedId)
      setConfirmRetry(false)
      setActionSuccess('Gas order queued for retry.')
      fetchOrders()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to retry gas order')
    }
  }

  async function handleRefund() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.refundGasOrder(selectedId)
      setConfirmRefund(false)
      setActionSuccess('Gas order refunded.')
      fetchOrders()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to refund gas order')
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading gas orders..." />
  if (error && orders.length === 0) return <ErrorState title={error} onRetry={fetchOrders} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Gas Fee Operations</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} gas orders</p>
      </div>

      {actionSuccess && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">
          {actionSuccess}
        </div>
      )}
      {actionError && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-border flex flex-wrap gap-2">
        {['all', 'pending', 'processing', 'completed', 'failed', 'refunded'].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border capitalize ${
              statusFilter === s
                ? 'bg-primary text-white border-primary'
                : 'bg-white text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <EmptyState title="No gas orders found" description="No gas orders match the current filter." />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order Ref</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tier</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">To Address</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Created</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{o.orderRef}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" size="sm">{o.tier}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {o.toAddress.slice(0, 8)}...{o.toAddress.slice(-6)}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <Badge variant={statusVariant(o.status)} size="sm">{o.status}</Badge>
                        {o.errorMessage && (
                          <p className="text-xs text-danger mt-0.5 max-w-xs truncate">{o.errorMessage}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {o.status === 'failed' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmRetry(true) }}
                          >
                            Retry
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmRefund(true) }}
                        >
                          Refund
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmRetry}
        onClose={() => setConfirmRetry(false)}
        onConfirm={handleRetry}
        title="Retry Gas Order"
        description="Retry this failed gas order? It will be re-queued for processing."
        confirmLabel="Retry"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmRefund}
        onClose={() => setConfirmRefund(false)}
        onConfirm={handleRefund}
        title="Refund Gas Order"
        description="Refund this gas order? The user will receive their fee back."
        confirmLabel="Refund"
        confirmVariant="danger"
      />
    </div>
  )
}

