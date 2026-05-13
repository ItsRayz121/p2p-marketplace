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
  address: string
  network: string
  status: 'pending' | 'first_approved' | 'approved' | 'rejected' | 'completed'
  firstApprovedBy?: string
  createdAt: string
}

interface WithdrawalsResponse {
  withdrawals: Withdrawal[]
  total: number
}

const statusVariant = (s: string) => {
  if (s === 'first_approved') return 'default'
  if (s === 'approved' || s === 'completed') return 'success'
  if (s === 'rejected') return 'danger'
  return 'warning'
}

const statusLabel = (s: string) => {
  if (s === 'first_approved') return '1 of 2 Approved'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function WithdrawalsPage() {
  const { user } = useAuthStore()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const [selected, setSelected] = useState<Withdrawal | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const limit = 20

  const fetchWithdrawals = useCallback(async () => {
    try {
      const data = await adminApi.getWithdrawals({ status: 'pending', page, limit }) as WithdrawalsResponse
      setWithdrawals(data.withdrawals ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load withdrawals')
    } finally {
      setLoading(false)
    }
  }, [page])

  usePolling(fetchWithdrawals, 30_000)

  function openModal(w: Withdrawal) {
    setSelected(w)
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
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

  const isSameAdmin = selected?.firstApprovedBy === user?.id
  const canFinalApprove = selected?.status === 'first_approved' && !isSameAdmin
  const canFirstApprove = selected?.status === 'pending'

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading withdrawals..." />
  if (error && withdrawals.length === 0) return <ErrorState title={error} onRetry={fetchWithdrawals} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Withdrawals</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} pending withdrawals â€” two-person approval required</p>
      </div>

      {withdrawals.length === 0 ? (
        <EmptyState title="No pending withdrawals" description="All withdrawals have been processed." />
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
                      {w.address.slice(0, 8)}...{w.address.slice(-6)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={statusVariant(w.status)}
                        size="sm"
                      >
                        {statusLabel(w.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{new Date(w.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(w)}>Review</Button>
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

      {/* Detail Modal */}
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
                <p className="font-mono text-xs text-text-primary break-all mt-0.5">{selected.address}</p>
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
                First approval completed. {isSameAdmin ? 'You approved this â€” a different admin must provide final approval.' : 'You can provide the final approval.'}
              </div>
            )}

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

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
            ? `Provide first approval for ${selected?.amount} ${selected?.coin} withdrawal? A second admin will need to approve before it executes.`
            : `Provide final approval for ${selected?.amount} ${selected?.coin} withdrawal? This will execute the on-chain transaction.`
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
    </div>
  )
}

