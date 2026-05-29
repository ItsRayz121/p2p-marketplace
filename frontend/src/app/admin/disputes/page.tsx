'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

// ─── Types ──────────────────────────────────────────────────────────────────────

interface TradeMessage { id: string; senderId: string; message: string; createdAt: string }

interface DisputeTrade {
  id: string
  orderRef: string
  buyerId: string
  sellerId: string
  coin: string
  amount: string
  fiatAmount: string
  totalPkr?: string
  paymentMethod: string
  paymentProofUrl?: string
  sellerTxHash?: string
  status: string
  disputeReason?: string
  disputeDescription?: string
  disputeMessages?: TradeMessage[]
  messages?: TradeMessage[]
  buyer?: { id: string; email: string; username: string }
  seller?: { id: string; email: string; username: string }
  ad?: { side: string }
  createdAt: string
  updatedAt: string
}

interface DisputeRecord {
  id: string
  tradeId: string
  openedById: string
  reason: string
  description: string
  status: string
  resolution?: string
  winner?: string
  resolvedAt?: string
  resolvedBy?: string
  createdAt: string
  updatedAt: string
  trade: DisputeTrade
  messages?: Array<{ id: string; senderId: string; message: string; createdAt: string }>
  openedBy?: { id: string; username: string; email: string } | null
}

interface DisputesResponse {
  disputes: DisputeRecord[]
  total?: number
  pagination?: { total: number }
}

function daysAgo(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24))
}

function slaLabel(date: string): string {
  const ms = Date.now() - new Date(date).getTime()
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ${h % 24}h`
  return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`
}

function slaBadgeClass(date: string): string {
  const days = daysAgo(date)
  if (days >= 3) return 'bg-red-100 text-red-700 border-red-200'
  if (days >= 1) return 'bg-orange-100 text-orange-700 border-orange-200'
  return 'bg-green-100 text-green-700 border-green-200'
}

const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'danger' => {
  if (s === 'disputed' || s === 'open' || s === 'escalated') return 'danger'
  if (s === 'resolved') return 'success'
  return 'warning'
}

const DIRECTION_LABELS: Record<string, string> = { buy: 'Buyer listing', sell: 'Seller listing' }

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<DisputeRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('open')

  const [selected, setSelected] = useState<DisputeRecord | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  // Resolve form
  const [winner, setWinner] = useState<'buyer' | 'seller'>('buyer')
  const [resolution, setResolution] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Close form
  const [showCloseForm, setShowCloseForm] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)

  // Add note form
  const [showNoteForm, setShowNoteForm] = useState(false)
  const [adminNote, setAdminNote] = useState('')

  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const limit = 20

  const fetchDisputes = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getDisputes(params) as unknown as DisputesResponse
      setDisputes(data.disputes ?? [])
      setTotal(data.pagination?.total ?? data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disputes')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchDisputes, 30_000)

  function openModal(d: DisputeRecord) {
    setSelected(d)
    setWinner('buyer')
    setResolution('')
    setResolutionNote('')
    setShowCloseForm(false)
    setCloseNote('')
    setShowNoteForm(false)
    setAdminNote('')
    setActionError(null)
    setActionSuccess(null)
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

  async function handleClose() {
    if (!selected || !closeNote.trim()) return
    setActionError(null)
    try {
      await adminApi.closeDispute(selected.id, { note: closeNote.trim() })
      setConfirmClose(false)
      setModalOpen(false)
      fetchDisputes()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to close dispute')
    }
  }

  async function handleAddNote() {
    if (!selected || !adminNote.trim()) return
    setActionError(null)
    try {
      await adminApi.addDisputeNote(selected.id, { note: adminNote.trim() })
      setActionSuccess('Note added successfully.')
      setAdminNote('')
      setShowNoteForm(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add note')
    }
  }

  const totalPages = Math.ceil(total / limit)
  const isResolved = selected?.status === 'resolved'

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
        <EmptyState icon={ShieldAlert} title="No disputes found" description="No disputes match the current filter." />
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
                  <th className="text-left px-4 py-3 font-medium text-text-muted">SLA</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {disputes.map((d) => (
                  <tr key={d.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      #{d.trade?.orderRef?.slice(0, 8) ?? d.tradeId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-text-primary">{d.trade?.buyer?.username || d.trade?.buyerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-primary">{d.trade?.seller?.username || d.trade?.sellerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(d.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${slaBadgeClass(d.createdAt)}`}>
                        {slaLabel(d.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(d.status)} size="sm">{d.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(d)}>View</Button>
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

      {/* ── Dispute Detail Modal ──────────────────────────────────────────────── */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={`Dispute — Trade #${selected?.trade?.orderRef?.slice(0, 8) ?? ''}`} size="xl">
        {selected && (
          <div className="space-y-5 max-h-[80vh] overflow-y-auto pr-1">

            {/* Trade Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted text-xs">Trade ID</p>
                <p className="font-mono text-xs text-text-primary break-all">{selected.tradeId}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Token / Amount</p>
                <p className="font-semibold text-text-primary">{selected.trade?.amount} {selected.trade?.coin}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">PKR Amount</p>
                <p className="font-semibold text-text-primary">PKR {Number(selected.trade?.fiatAmount ?? selected.trade?.totalPkr ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Direction</p>
                <p className="text-text-primary">{DIRECTION_LABELS[selected.trade?.ad?.side ?? ''] ?? selected.trade?.ad?.side ?? '—'}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Payment Method</p>
                <p className="text-text-primary">{selected.trade?.paymentMethod || '—'}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Dispute Status</p>
                <Badge variant={statusVariant(selected.status)} size="sm">{selected.status}</Badge>
              </div>
            </div>

            {/* Parties */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-white border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">Buyer</p>
                <Link href={`/admin/users/${selected.trade?.buyer?.id ?? selected.trade?.buyerId}`} className="font-semibold text-primary hover:underline">
                  {selected.trade?.buyer?.username || 'Unknown'}
                </Link>
                <p className="text-xs text-text-muted">{selected.trade?.buyer?.email}</p>
              </div>
              <div className="p-3 bg-white border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">Seller</p>
                <Link href={`/admin/users/${selected.trade?.seller?.id ?? selected.trade?.sellerId}`} className="font-semibold text-primary hover:underline">
                  {selected.trade?.seller?.username || 'Unknown'}
                </Link>
                <p className="text-xs text-text-muted">{selected.trade?.seller?.email}</p>
              </div>
            </div>

            {/* Who opened */}
            <div className="text-sm text-text-muted">
              Dispute opened by{' '}
              <span className="font-semibold text-text-primary">
                {selected.openedBy?.username ?? selected.openedById.slice(0, 8)}
              </span>
              {' '}on {fmtDateTime(selected.createdAt)}
            </div>

            {/* Dispute Reason & Description */}
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Dispute Reason</p>
                <p className="text-sm text-text-secondary bg-danger/5 border border-danger/10 rounded-lg px-3 py-2">
                  {selected.reason}
                </p>
              </div>
              {selected.description && (
                <div>
                  <p className="text-sm font-medium text-text-primary mb-1">Description</p>
                  <p className="text-sm text-text-secondary whitespace-pre-wrap bg-surface border border-border rounded-lg px-3 py-2">
                    {selected.description}
                  </p>
                </div>
              )}
            </div>

            {/* Payment Proof */}
            {selected.trade?.paymentProofUrl && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Payment Proof</p>
                <a href={selected.trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={selected.trade.paymentProofUrl}
                    alt="Payment proof"
                    className="max-w-xs rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer"
                  />
                </a>
              </div>
            )}

            {/* Token Transfer Hash */}
            {selected.trade?.sellerTxHash && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Token Transfer Hash</p>
                <p className="font-mono text-xs text-primary break-all bg-surface border border-border rounded-lg px-3 py-2">
                  {selected.trade.sellerTxHash}
                </p>
              </div>
            )}

            {/* Chat Messages */}
            {(selected.trade?.messages ?? []).length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Trade Chat</p>
                <div className="space-y-2 max-h-48 overflow-y-auto border border-border rounded-xl p-3 bg-surface">
                  {(selected.trade?.messages ?? []).map((msg) => {
                    const isBuyer = msg.senderId === (selected.trade?.buyer?.id ?? selected.trade?.buyerId)
                    return (
                      <div key={msg.id} className="text-xs">
                        <span className={`font-semibold ${isBuyer ? 'text-blue-600' : 'text-green-700'}`}>
                          {isBuyer ? selected.trade?.buyer?.username ?? 'Buyer' : selected.trade?.seller?.username ?? 'Seller'}:
                        </span>
                        <span className="text-text-secondary ml-1">{msg.message}</span>
                        <span className="text-text-muted ml-2">{fmtTime(msg.createdAt)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Dispute Messages (from DisputeMessage table) */}
            {(selected.messages ?? []).length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Dispute Evidence & Notes</p>
                <div className="space-y-2 max-h-36 overflow-y-auto border border-border rounded-xl p-3 bg-surface">
                  {(selected.messages ?? []).map((msg) => (
                    <div key={msg.id} className="text-xs">
                      <span className="font-semibold text-text-secondary">
                        {msg.senderId === (selected.trade?.buyer?.id ?? selected.trade?.buyerId) ? 'Buyer' :
                         msg.senderId === (selected.trade?.seller?.id ?? selected.trade?.sellerId) ? 'Seller' : 'Admin'}:
                      </span>
                      <span className="text-text-secondary ml-1">{msg.message}</span>
                      <span className="text-text-muted ml-2">{fmtTime(msg.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolution info (if already resolved) */}
            {isResolved && selected.resolution && (
              <div className="p-3 bg-success/5 border border-success/20 rounded-xl text-sm">
                <p className="font-semibold text-success mb-0.5">Resolved — {selected.winner ? `in favour of ${selected.winner}` : 'closed'}</p>
                <p className="text-text-secondary">{selected.resolution}</p>
                {selected.resolvedAt && <p className="text-xs text-text-muted mt-1">{fmtDateTime(selected.resolvedAt)}</p>}
              </div>
            )}

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}
            {actionSuccess && (
              <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">
                {actionSuccess}
              </div>
            )}

            {/* Action Buttons */}
            {!isResolved && (
              <div className="space-y-4 pt-2 border-t border-border">
                {/* Resolve in buyer/seller favor */}
                <div>
                  <p className="text-sm font-medium text-text-primary mb-2">Award in favor of</p>
                  <div className="flex gap-3 mb-3">
                    <button
                      onClick={() => setWinner('buyer')}
                      className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        winner === 'buyer' ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:bg-surface'
                      }`}
                    >
                      Buyer — {selected.trade?.buyer?.username}
                    </button>
                    <button
                      onClick={() => setWinner('seller')}
                      className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        winner === 'seller' ? 'bg-primary text-white border-primary' : 'bg-white text-text-secondary border-border hover:bg-surface'
                      }`}
                    >
                      Seller — {selected.trade?.seller?.username}
                    </button>
                  </div>
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    rows={2}
                    placeholder="Resolution summary (required)..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                  <textarea
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    rows={1}
                    placeholder="Internal note (optional)..."
                    className="w-full mt-1.5 px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                  <Button
                    variant="primary"
                    fullWidth
                    disabled={!resolution.trim()}
                    onClick={() => setConfirmOpen(true)}
                    className="mt-2"
                  >
                    Resolve Dispute
                  </Button>
                </div>

                {/* Close without winner */}
                {showCloseForm ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-text-primary">Close Dispute (no winner)</p>
                    <textarea
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                      rows={2}
                      placeholder="Reason for closing..."
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-danger resize-none"
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" fullWidth onClick={() => setShowCloseForm(false)}>Cancel</Button>
                      <Button variant="danger" fullWidth disabled={!closeNote.trim()} onClick={() => setConfirmClose(true)}>Close Dispute</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" fullWidth onClick={() => setShowCloseForm(true)}>
                    Close Dispute (No Winner)
                  </Button>
                )}

                {/* Add admin note */}
                {showNoteForm ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-text-primary">Add Admin Note</p>
                    <textarea
                      value={adminNote}
                      onChange={(e) => setAdminNote(e.target.value)}
                      rows={2}
                      placeholder="Internal note visible in dispute messages..."
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" fullWidth onClick={() => setShowNoteForm(false)}>Cancel</Button>
                      <Button variant="primary" fullWidth disabled={!adminNote.trim()} onClick={handleAddNote}>Add Note</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" fullWidth onClick={() => setShowNoteForm(true)}>
                    Add Admin Note
                  </Button>
                )}
              </div>
            )}
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

      <ConfirmModal
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={handleClose}
        title="Close Dispute"
        description="Close this dispute without awarding either party? This action cannot be undone."
        confirmLabel="Close Dispute"
        confirmVariant="danger"
      />
    </div>
  )
}
