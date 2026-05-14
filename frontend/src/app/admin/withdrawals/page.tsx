'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface Withdrawal {
  id: string
  userId: string
  user?: { email: string; username: string }
  coin: string
  amount: string
  fee: string
  // Prisma field is `toAddress` — NOT `address`
  toAddress: string
  network: string
  status: 'pending' | 'first_approved' | 'approved' | 'rejected' | 'sent' | 'completed'
  firstApprovedBy?: string
  txHash?: string
  rejectionReason?: string
  createdAt: string
}

interface WithdrawalsResponse {
  withdrawals: Withdrawal[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

type StatusFilter = 'pending' | 'first_approved' | 'approved' | 'all'

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'first_approved', label: '1st Approved' },
  { value: 'approved', label: 'Ready to Send' },
  { value: 'all', label: 'All' },
]

const statusVariant = (s: string) => {
  if (s === 'first_approved') return 'default'
  if (s === 'approved') return 'warning'
  if (s === 'sent' || s === 'completed') return 'success'
  if (s === 'rejected') return 'danger'
  return 'warning'
}

const statusLabel = (s: string) => {
  if (s === 'first_approved') return '1 of 2 Approved'
  if (s === 'approved') return 'Ready to Send'
  if (s === 'sent') return 'Sent'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function WithdrawalsPage() {
  const { user } = useAuthStore()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')

  const [selected, setSelected] = useState<Withdrawal | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // mark-sent state
  const [markSentOpen, setMarkSentOpen] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [adminNote, setAdminNote] = useState('')
  const [confirmMarkSent, setConfirmMarkSent] = useState(false)

  const limit = 20

  const fetchWithdrawals = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getWithdrawals(params) as WithdrawalsResponse
      setWithdrawals(data.withdrawals ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load withdrawals')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchWithdrawals, 30_000)

  function openModal(w: Withdrawal) {
    setSelected(w)
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
  }

  function openMarkSent(w: Withdrawal) {
    setSelected(w)
    setTxHash('')
    setAdminNote('')
    setActionError(null)
    setMarkSentOpen(true)
  }

  async function handleApprove() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.approveWithdrawal(selected.id)
      setConfirmApprove(false)
      setModalOpen(false)
      fetchWithdrawals()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve withdrawal')
    }
  }

  async function handleReject() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.rejectWithdrawal(selected.id, { reason: rejectReason })
      setConfirmReject(false)
      setModalOpen(false)
      fetchWithdrawals()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject withdrawal')
    }
  }

  async function handleMarkSent() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.markWithdrawalSent(selected.id, { txHash, adminNote: adminNote || undefined })
      setConfirmMarkSent(false)
      setMarkSentOpen(false)
      fetchWithdrawals()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark withdrawal as sent')
    }
  }

  const isSameAdmin = selected?.firstApprovedBy === user?.id
  const canFinalApprove = selected?.status === 'first_approved' && !isSameAdmin
  const canFirstApprove = selected?.status === 'pending'
  const canMarkSent = selected?.status === 'approved'

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading withdrawals..." />
  if (error && withdrawals.length === 0) return <ErrorState title={error} onRetry={fetchWithdrawals} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Withdrawals</h1>
        <p className="text-text-muted text-sm mt-0.5">Two-person approval required before marking as sent</p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 p-1 bg-surface rounded-xl border border-border w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setPage(1); setLoading(true) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === tab.value
                ? 'bg-white text-text-primary shadow-sm border border-border'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {withdrawals.length === 0 ? (
        <EmptyState title="No withdrawals" description={`No ${statusFilter === 'all' ? '' : statusFilter.replace('_', ' ')} withdrawals found.`} />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Coin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Fee</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Address</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {withdrawals.map((w) => (
                  <tr key={w.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{w.user?.username}</p>
                      <p className="text-xs text-text-muted">{w.user?.email}</p>
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary">{w.coin}</td>
                    <td className="px-4 py-3 font-semibold text-text-primary">{w.amount}</td>
                    <td className="px-4 py-3 text-text-secondary">{w.fee}</td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {w.toAddress
                        ? `${w.toAddress.slice(0, 8)}...${w.toAddress.slice(-6)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(w.status)} size="sm">
                        {statusLabel(w.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{new Date(w.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">
                      {w.status === 'approved' ? (
                        <Button size="sm" variant="primary" onClick={() => openMarkSent(w)}>Mark Sent</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => openModal(w)}>Review</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages} ({total} total)</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Approve / Reject Detail Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Withdrawal Details" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">User</p>
                <p className="font-medium text-text-primary">{selected.user?.username}</p>
                <p className="text-xs text-text-muted">{selected.user?.email}</p>
              </div>
              <div>
                <p className="text-text-muted">Amount</p>
                <p className="font-bold text-text-primary text-lg">{selected.amount} {selected.coin}</p>
              </div>
              <div>
                <p className="text-text-muted">Network Fee</p>
                <p className="text-text-primary">{selected.fee} {selected.coin}</p>
              </div>
              <div>
                <p className="text-text-muted">Network</p>
                <p className="text-text-primary">{selected.network}</p>
              </div>
              <div className="col-span-2">
                <p className="text-text-muted">Destination Address</p>
                <p className="font-mono text-xs text-text-primary break-all mt-0.5">{selected.toAddress}</p>
              </div>
              <div>
                <p className="text-text-muted">Status</p>
                <Badge variant={statusVariant(selected.status)}>{statusLabel(selected.status)}</Badge>
              </div>
              <div>
                <p className="text-text-muted">Submitted</p>
                <p className="text-text-secondary">{new Date(selected.createdAt).toLocaleString()}</p>
              </div>
            </div>

            {selected.status === 'first_approved' && (
              <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-primary">
                First approval completed. {isSameAdmin
                  ? 'You approved this — a different admin must provide final approval.'
                  : 'You can provide the final approval.'}
              </div>
            )}

            {selected.rejectionReason && (
              <div className="px-4 py-3 bg-danger/5 border border-danger/20 rounded-xl text-sm text-danger">
                Rejection reason: {selected.rejectionReason}
              </div>
            )}

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            {(canFirstApprove || canFinalApprove) && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Rejection Reason (required to reject)
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                  placeholder="Reason for rejection..."
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>
            )}

            {(canFirstApprove || canFinalApprove) && (
              <div className="flex gap-3 pt-2">
                <Button
                  variant="danger"
                  onClick={() => { if (rejectReason.trim()) setConfirmReject(true) }}
                  disabled={!rejectReason.trim()}
                  className="flex-1"
                >
                  Reject
                </Button>

                {canFirstApprove && (
                  <Button variant="primary" onClick={() => setConfirmApprove(true)} className="flex-1">
                    Approve (1st)
                  </Button>
                )}

                {selected.status === 'first_approved' && isSameAdmin && (
                  <div className="flex-1 flex items-center justify-center px-4 py-2 bg-surface rounded-lg text-sm text-text-muted border border-border text-center">
                    Awaiting 2nd approval
                  </div>
                )}

                {canFinalApprove && (
                  <Button variant="primary" onClick={() => setConfirmApprove(true)} className="flex-1">
                    Approve (Final)
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Mark Sent Modal */}
      <Modal isOpen={markSentOpen} onClose={() => setMarkSentOpen(false)} title="Mark Withdrawal as Sent" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl text-sm">
              <p className="font-medium text-warning mb-1">Final step — confirm the on-chain transaction</p>
              <p className="text-text-secondary">
                Broadcasting <span className="font-bold">{selected.amount} {selected.coin}</span> to{' '}
                <span className="font-mono">{selected.toAddress?.slice(0, 12)}...{selected.toAddress?.slice(-6)}</span> on {selected.network}.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Transaction Hash <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm font-mono text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Admin Note (optional)
              </label>
              <textarea
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                rows={2}
                placeholder="Any notes about this payout..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button variant="secondary" onClick={() => setMarkSentOpen(false)} className="flex-1">
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => { if (txHash.trim()) setConfirmMarkSent(true) }}
                disabled={!txHash.trim()}
                className="flex-1"
              >
                Confirm Sent
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        onConfirm={handleApprove}
        title={selected?.status === 'pending' ? 'First Approval' : 'Final Approval'}
        description={
          selected?.status === 'pending'
            ? `Provide first approval for ${selected?.amount} ${selected?.coin} withdrawal? A second admin must approve before it can be sent.`
            : `Provide final approval for ${selected?.amount} ${selected?.coin} withdrawal? Status will become "Ready to Send."`
        }
        confirmLabel="Approve"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject Withdrawal"
        description={`Reject this withdrawal of ${selected?.amount} ${selected?.coin}? The funds will be returned to the user's balance.`}
        confirmLabel="Reject"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={confirmMarkSent}
        onClose={() => setConfirmMarkSent(false)}
        onConfirm={handleMarkSent}
        title="Confirm Mark as Sent"
        description={`Mark ${selected?.amount} ${selected?.coin} withdrawal as sent with tx hash ${txHash.slice(0, 16)}...? This action cannot be undone.`}
        confirmLabel="Mark as Sent"
        confirmVariant="primary"
      />
    </div>
  )
}
