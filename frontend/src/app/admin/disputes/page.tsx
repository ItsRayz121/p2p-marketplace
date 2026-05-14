'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface DisputeTrade {
  id: string
  buyerId: string
  sellerId: string
  coin: string
  amount: string
  totalPkr: string
  status: string
  disputeReason?: string
  disputeDescription?: string
  disputeMessages?: Array<{ senderId: string; message: string; createdAt: string }>
  buyer?: { email: string; username: string }
  seller?: { email: string; username: string }
  createdAt: string
  updatedAt: string
}

interface DisputesResponse {
  disputes: DisputeTrade[]
  total: number
}

function daysAgo(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24))
}

const statusVariant = (s: string) => {
  if (s === 'disputed') return 'danger'
  if (s === 'resolved') return 'success'
  return 'warning'
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<DisputeTrade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('open')

  const [selected, setSelected] = useState<DisputeTrade | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [winner, setWinner] = useState<'buyer' | 'seller'>('buyer')
  const [resolution, setResolution] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const limit = 20

  const fetchDisputes = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getDisputes(params) as DisputesResponse
      setDisputes(data.disputes ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disputes')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchDisputes, 30_000)

  function openModal(d: DisputeTrade) {
    setSelected(d)
    setWinner('buyer')
    setResolution('')
    setResolutionNote('')
    setActionError(null)
    setModalOpen(true)
  }

  async function handleResolve() {
    if (!selected || !resolution.trim()) return
    setActionError(null)
    try {
      await adminApi.resolveDispute(selected.id, { winner, resolution, resolutionNote })
      setConfirmOpen(false)
      setModalOpen(false)
      fetchDisputes()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve dispute')
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading disputes..." />
  if (error && disputes.length === 0) return <ErrorState title={error} onRetry={fetchDisputes} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Disputes</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} disputes found</p>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-border flex flex-wrap gap-2">
        {[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'escalated', label: 'Escalated' },
          { value: 'all', label: 'All' },
        ].map((f) => (
          <button
            key={f.value}
            onClick={() => { setStatusFilter(f.value); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
              statusFilter === f.value
                ? 'bg-primary text-white border-primary'
                : 'bg-white text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {disputes.length === 0 ? (
        <EmptyState title="No disputes found" description="No disputes match the current filter." />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Trade ID</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Buyer</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Seller</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Opened</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Days Open</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {disputes.map((d) => (
                  <tr key={d.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{d.id.slice(0, 8)}...</td>
                    <td className="px-4 py-3 text-text-primary">{d.buyer?.username || d.buyerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-primary">{d.seller?.username || d.sellerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(d.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`font-medium ${daysAgo(d.createdAt) > 2 ? 'text-danger' : 'text-text-secondary'}`}>
                        {daysAgo(d.createdAt)}d
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(d.status)} size="sm">{d.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(d)}>Resolve</Button>
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

      {/* Resolve Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Resolve Dispute" size="lg">
        {selected && (
          <div className="space-y-5">
            {/* Trade details */}
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">Trade ID</p>
                <p className="font-mono text-xs text-text-primary">{selected.id}</p>
              </div>
              <div>
                <p className="text-text-muted">Amount</p>
                <p className="font-semibold text-text-primary">{selected.amount} {selected.coin}</p>
              </div>
              <div>
                <p className="text-text-muted">Buyer</p>
                <p className="text-text-primary">{selected.buyer?.username || selected.buyerId?.slice(0, 8) || 'Unknown'}</p>
                <p className="text-xs text-text-muted">{selected.buyer?.email}</p>
              </div>
              <div>
                <p className="text-text-muted">Seller</p>
                <p className="text-text-primary">{selected.seller?.username || selected.sellerId?.slice(0, 8) || 'Unknown'}</p>
                <p className="text-xs text-text-muted">{selected.seller?.email}</p>
              </div>
            </div>

            {selected.disputeReason && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Dispute Reason</p>
                <p className="text-sm text-text-secondary bg-danger/5 border border-danger/10 rounded-lg px-3 py-2">
                  {selected.disputeReason}
                </p>
              </div>
            )}

            {selected.disputeDescription && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Description</p>
                <p className="text-sm text-text-secondary">{selected.disputeDescription}</p>
              </div>
            )}

            {selected.disputeMessages && selected.disputeMessages.length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Evidence Messages</p>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {selected.disputeMessages.map((msg, i) => (
                    <div key={i} className="text-xs bg-surface rounded-lg px-3 py-2">
                      <span className="font-medium text-text-secondary">
                        {msg.senderId === selected.buyerId ? 'Buyer' : 'Seller'}:
                      </span>
                      <span className="text-text-secondary ml-1">{msg.message}</span>
                      <span className="text-text-muted ml-2">{fmtTime(msg.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Winner select */}
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">Award in favor of</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setWinner('buyer')}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    winner === 'buyer' ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:bg-surface'
                  }`}
                >
                  Buyer â€” {selected.buyer?.username}
                </button>
                <button
                  onClick={() => setWinner('seller')}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    winner === 'seller' ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:bg-surface'
                  }`}
                >
                  Seller â€” {selected.seller?.username}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Resolution Summary <span className="text-danger">*</span>
              </label>
              <textarea
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={2}
                placeholder="Brief summary of your decision..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Resolution Note (optional)
              </label>
              <textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={2}
                placeholder="Additional internal notes..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            <Button
              variant="primary"
              fullWidth
              disabled={!resolution.trim()}
              onClick={() => setConfirmOpen(true)}
            >
              Resolve Dispute
            </Button>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleResolve}
        title="Confirm Resolution"
        description={`Resolve this dispute in favor of the ${winner}? This action cannot be undone.`}
        confirmLabel="Resolve"
        confirmVariant="danger"
      />
    </div>
  )
}

