'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtPkr } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input } from '@/components/ui/Input'

interface InstantBuyOrder {
  id: string
  orderRef: string
  userId: string
  user?: { email: string; username: string }
  coin: string
  amountPkr: string
  amountCrypto: string
  paymentMode: string
  ocrConfidence?: number
  ocrExtractedAmount?: string
  layer1Result?: string
  paymentProofUrl?: string
  status: string
  createdAt: string
}

interface InstantBuyResponse {
  orders: InstantBuyOrder[]
  total: number
}

export default function InstantBuyPage() {
  const [orders, setOrders] = useState<InstantBuyOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const [selected, setSelected] = useState<InstantBuyOrder | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const limit = 20

  const fetchOrders = useCallback(async () => {
    try {
      const data = await adminApi.getInstantBuyOrders({ status: 'admin_review', page, limit }) as InstantBuyResponse
      setOrders(data.orders ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load instant buy orders')
    } finally {
      setLoading(false)
    }
  }, [page])

  usePolling(fetchOrders, 30_000)

  function openModal(order: InstantBuyOrder) {
    setSelected(order)
    setTxHash('')
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
  }

  async function handleApprove() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.approveInstantBuy(selected.id, { txHash })
      setConfirmApprove(false)
      setModalOpen(false)
      fetchOrders()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve order')
    }
  }

  async function handleReject() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.rejectInstantBuy(selected.id, { reason: rejectReason })
      setConfirmReject(false)
      setModalOpen(false)
      fetchOrders()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject order')
    }
  }

  const totalPages = Math.ceil(total / limit)

  const confidenceColor = (c?: number) => {
    if (!c) return 'text-text-muted'
    if (c >= 80) return 'text-success'
    if (c >= 60) return 'text-warning'
    return 'text-danger'
  }

  if (loading) return <LoadingState message="Loading instant buy orders..." />
  if (error && orders.length === 0) return <ErrorState title={error} onRetry={fetchOrders} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Instant Buy — Admin Review</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} orders awaiting review</p>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon={Zap} title="No orders pending review" description="All instant buy orders have been processed." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order Ref</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Coin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Payment</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">OCR</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">L1 Result</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{o.orderRef}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{o.user?.username}</p>
                      <p className="text-xs text-text-muted">{o.user?.email}</p>
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary">{o.coin}</td>
                    <td className="px-4 py-3">
                      <p className="text-text-primary">{fmtPkr(o.amountPkr)}</p>
                      <p className="text-xs text-text-muted">{o.amountCrypto} {o.coin}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="default" size="sm">{o.paymentMode}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {o.ocrConfidence != null ? (
                        <span className={`font-medium ${confidenceColor(o.ocrConfidence)}`}>
                          {o.ocrConfidence}%
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {o.layer1Result ? (
                        <Badge variant={o.layer1Result === 'passed' ? 'success' : 'danger'} size="sm">
                          {o.layer1Result}
                        </Badge>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(o)}>Review</Button>
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

      {/* Review Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Review Instant Buy Order" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">Order Ref</p>
                <p className="font-mono text-xs text-text-primary">{selected.orderRef}</p>
              </div>
              <div>
                <p className="text-text-muted">User</p>
                <p className="text-text-primary">{selected.user?.username}</p>
                <p className="text-xs text-text-muted">{selected.user?.email}</p>
              </div>
              <div>
                <p className="text-text-muted">Amount</p>
                <p className="font-semibold text-text-primary">{fmtPkr(selected.amountPkr)}</p>
                <p className="text-xs text-text-muted">{selected.amountCrypto} {selected.coin}</p>
              </div>
              <div>
                <p className="text-text-muted">Payment Mode</p>
                <Badge variant="default">{selected.paymentMode}</Badge>
              </div>
              <div>
                <p className="text-text-muted">OCR Confidence</p>
                <p className={`font-semibold ${confidenceColor(selected.ocrConfidence)}`}>
                  {selected.ocrConfidence != null ? `${selected.ocrConfidence}%` : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-text-muted">OCR Extracted Amount</p>
                <p className="text-text-primary">{selected.ocrExtractedAmount ?? 'N/A'}</p>
              </div>
            </div>

            {selected.paymentProofUrl && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Payment Proof</p>
                <a
                  href={selected.paymentProofUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-surface text-sm text-primary"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  View Payment Proof
                </a>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Transaction Hash <span className="text-danger">*</span> (required for approval)
              </label>
              <Input
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Rejection Reason (required for rejection)
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={2}
                placeholder="Explain why this order is being rejected..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                variant="danger"
                onClick={() => { if (rejectReason.trim()) setConfirmReject(true) }}
                disabled={!rejectReason.trim()}
                className="flex-1"
              >
                Reject
              </Button>
              <Button
                variant="primary"
                onClick={() => { if (txHash.trim()) setConfirmApprove(true) }}
                disabled={!txHash.trim()}
                className="flex-1"
              >
                Approve
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        onConfirm={handleApprove}
        title="Approve Instant Buy Order"
        description={`Approve this order and release ${selected?.amountCrypto} ${selected?.coin} to the user?`}
        confirmLabel="Approve & Release"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject Instant Buy Order"
        description="Reject this order? The user's payment will be refunded."
        confirmLabel="Reject Order"
        confirmVariant="danger"
      />
    </div>
  )
}

