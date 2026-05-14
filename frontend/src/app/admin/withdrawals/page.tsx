'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { useAuthStore } from '@/store/auth.store'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

// ─── Types ─────────────────────────────────────────────────────────────────────

type WithdrawalStatus =
  | 'pending'
  | 'first_approved'
  | 'approved'
  | 'auto_approved'
  | 'on_hold'
  | 'sent'
  | 'completed'
  | 'rejected'
  | 'cancelled'

type RiskFlag = 'FIRST_WITHDRAWAL' | 'NEW_WALLET' | 'VELOCITY_EXCEEDED' | 'AMOUNT_SPIKE'

interface Withdrawal {
  id: string
  userId: string
  user?: { email: string; username: string }
  coin: string
  amount: string
  fee: string
  toAddress: string
  network: string
  status: WithdrawalStatus
  tier: number
  riskScore: number
  riskFlags: RiskFlag[]
  amountUsd?: string
  firstApprovedBy?: string
  txHash?: string
  rejectionReason?: string
  onHoldBy?: string
  onHoldReason?: string
  riskOverride?: boolean
  riskOverrideNote?: string
  createdAt: string
}

interface WithdrawalsResponse {
  withdrawals: Withdrawal[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

// ─── Status display helpers ────────────────────────────────────────────────────

type StatusFilter = 'pending' | 'first_approved' | 'approved' | 'auto_approved' | 'on_hold' | 'all'

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'first_approved', label: '1st Approved' },
  { value: 'approved', label: 'Ready to Send' },
  { value: 'auto_approved', label: 'Auto-Approved' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'all', label: 'All' },
]

const statusVariant = (s: WithdrawalStatus): 'default' | 'success' | 'warning' | 'danger' | 'outline' => {
  if (s === 'auto_approved') return 'success'
  if (s === 'approved') return 'warning'
  if (s === 'first_approved') return 'default'
  if (s === 'on_hold') return 'danger'
  if (s === 'sent' || s === 'completed') return 'success'
  if (s === 'rejected') return 'danger'
  return 'outline'
}

const statusLabel = (s: WithdrawalStatus): string => {
  const labels: Record<WithdrawalStatus, string> = {
    pending: 'Pending',
    first_approved: '1 of 2 Approved',
    approved: 'Ready to Send',
    auto_approved: 'Auto-Approved',
    on_hold: 'On Hold',
    sent: 'Sent',
    completed: 'Sent',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
  }
  return labels[s] ?? s
}

const tierLabel = (tier: number) => {
  if (tier === 1) return 'T1 · Auto'
  if (tier === 2) return 'T2 · 1 Admin'
  if (tier === 3) return 'T3 · 2 Admins'
  return 'T4 · Hold'
}

const tierColor = (tier: number) => {
  if (tier === 1) return 'text-success bg-success/10'
  if (tier === 2) return 'text-primary bg-primary/10'
  if (tier === 3) return 'text-warning bg-warning/10'
  return 'text-danger bg-danger/10'
}

const riskFlagLabel = (flag: RiskFlag) => {
  const labels: Record<RiskFlag, string> = {
    FIRST_WITHDRAWAL: 'First withdrawal',
    NEW_WALLET: 'New address',
    VELOCITY_EXCEEDED: 'High velocity',
    AMOUNT_SPIKE: 'Amount spike',
  }
  return labels[flag] ?? flag
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function WithdrawalsPage() {
  const { user } = useAuthStore()
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')

  // review modal
  const [selected, setSelected] = useState<Withdrawal | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [holdReason, setHoldReason] = useState('')
  const [overrideNote, setOverrideNote] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [confirmHold, setConfirmHold] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // mark-sent modal
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
    setHoldReason('')
    setOverrideNote('')
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

  async function handleHold() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.holdWithdrawal(selected.id, { reason: holdReason })
      setConfirmHold(false)
      setModalOpen(false)
      fetchWithdrawals()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to place hold')
    }
  }

  async function handleRelease() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.releaseWithdrawalHold(selected.id)
      setConfirmRelease(false)
      setModalOpen(false)
      fetchWithdrawals()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to release hold')
    }
  }

  async function handleRiskOverride() {
    if (!selected || !overrideNote.trim()) return
    setActionError(null)
    try {
      await adminApi.overrideWithdrawalRisk(selected.id, { note: overrideNote })
      fetchWithdrawals()
      setOverrideNote('')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to apply risk override')
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
      setActionError(err instanceof Error ? err.message : 'Failed to mark as sent')
    }
  }

  const isSameAdmin = selected?.firstApprovedBy === user?.id
  const canApprove = selected?.status === 'pending' || (selected?.status === 'first_approved' && !isSameAdmin)
  const canMarkSent = selected?.status === 'approved' || selected?.status === 'auto_approved'
  const canHold = selected ? !['sent', 'completed', 'rejected', 'cancelled', 'on_hold'].includes(selected.status) : false
  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading withdrawals..." />
  if (error && withdrawals.length === 0) return <ErrorState title={error} onRetry={fetchWithdrawals} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Withdrawals</h1>
        <p className="text-text-muted text-sm mt-0.5">
          Tiered approval: T1 auto-approved · T2 single admin · T3 dual admin · T4 security hold
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-surface rounded-xl border border-border w-fit">
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
        <EmptyState
          title="No withdrawals"
          description={`No ${statusFilter === 'all' ? '' : statusFilter.replace('_', ' ')} withdrawals found.`}
        />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Coin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tier / Risk</th>
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
                    <td className="px-4 py-3">
                      <p className="font-semibold text-text-primary">{w.amount} {w.coin}</p>
                      {w.amountUsd && (
                        <p className="text-xs text-text-muted">≈ ${parseFloat(w.amountUsd).toFixed(2)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${tierColor(w.tier ?? 3)}`}>
                        {tierLabel(w.tier ?? 3)}
                      </span>
                      {w.riskFlags?.length > 0 && (
                        <p className="text-xs text-danger mt-0.5">⚠ {w.riskFlags.length} flag{w.riskFlags.length > 1 ? 's' : ''}</p>
                      )}
                      {w.riskOverride && (
                        <p className="text-xs text-text-muted mt-0.5">Override applied</p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {w.toAddress ? `${w.toAddress.slice(0, 8)}...${w.toAddress.slice(-6)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(w.status)} size="sm">
                        {statusLabel(w.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(w.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {canMarkSentFor(w) ? (
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

      {/* ── Review / Detail Modal ───────────────────────────────────────────── */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Withdrawal Details" size="lg">
        {selected && (
          <div className="space-y-5">
            {/* Summary grid */}
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">User</p>
                <p className="font-medium text-text-primary">{selected.user?.username}</p>
                <p className="text-xs text-text-muted">{selected.user?.email}</p>
              </div>
              <div>
                <p className="text-text-muted">Amount</p>
                <p className="font-bold text-text-primary text-lg">{selected.amount} {selected.coin}</p>
                {selected.amountUsd && (
                  <p className="text-xs text-text-muted">≈ ${parseFloat(selected.amountUsd).toFixed(2)} USD</p>
                )}
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
                <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
              </div>
            </div>

            {/* Risk assessment panel */}
            <div className={`p-4 rounded-xl border text-sm ${selected.riskFlags?.length > 0 ? 'bg-warning/5 border-warning/20' : 'bg-surface border-border'}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-text-primary">Risk Assessment</p>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${tierColor(selected.tier ?? 3)}`}>
                    {tierLabel(selected.tier ?? 3)}
                  </span>
                  <span className={`text-xs font-medium ${(selected.riskScore ?? 0) >= 50 ? 'text-danger' : (selected.riskScore ?? 0) >= 25 ? 'text-warning' : 'text-success'}`}>
                    Score {selected.riskScore ?? 0}/100
                  </span>
                </div>
              </div>
              {selected.riskFlags?.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {selected.riskFlags.map((f) => (
                    <span key={f} className="text-xs px-2 py-0.5 bg-warning/15 text-warning rounded-full font-medium">
                      ⚠ {riskFlagLabel(f)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-text-muted text-xs">No risk flags — clean profile</p>
              )}
              {selected.riskOverride && (
                <p className="text-xs text-text-muted mt-2">
                  Override applied: {selected.riskOverrideNote}
                </p>
              )}

              {/* Risk override input */}
              {!selected.riskOverride && selected.riskFlags?.length > 0 && (
                <div className="mt-3 flex gap-2">
                  <input
                    value={overrideNote}
                    onChange={(e) => setOverrideNote(e.target.value)}
                    placeholder="Override reason (e.g. known trusted user)"
                    className="flex-1 px-2.5 py-1.5 border border-border rounded-lg text-xs bg-white focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!overrideNote.trim()}
                    onClick={handleRiskOverride}
                  >
                    Override Risk
                  </Button>
                </div>
              )}
            </div>

            {/* Hold info */}
            {selected.status === 'on_hold' && selected.onHoldReason && (
              <div className="px-4 py-3 bg-danger/5 border border-danger/20 rounded-xl text-sm text-danger">
                <span className="font-medium">On Hold:</span> {selected.onHoldReason}
              </div>
            )}

            {/* first_approved info */}
            {selected.status === 'first_approved' && (
              <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-primary">
                First approval recorded.{' '}
                {isSameAdmin
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

            {/* Actions */}
            {selected.status === 'on_hold' ? (
              <div className="flex gap-3 pt-2">
                <Button
                  variant="danger"
                  onClick={() => { if (rejectReason.trim()) setConfirmReject(true) }}
                  disabled={!rejectReason.trim()}
                  className="flex-1"
                >
                  Reject
                </Button>
                <Button variant="primary" onClick={() => setConfirmRelease(true)} className="flex-1">
                  Release Hold
                </Button>
              </div>
            ) : canApprove ? (
              <>
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

                  {canHold && (
                    <div className="flex-1 space-y-1.5">
                      <input
                        value={holdReason}
                        onChange={(e) => setHoldReason(e.target.value)}
                        placeholder="Hold reason..."
                        className="w-full px-2.5 py-1.5 border border-border rounded-lg text-xs bg-white focus:outline-none focus:ring-1 focus:ring-warning"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!holdReason.trim()}
                        onClick={() => setConfirmHold(true)}
                        className="w-full"
                      >
                        Place on Hold
                      </Button>
                    </div>
                  )}

                  <Button
                    variant="primary"
                    onClick={() => setConfirmApprove(true)}
                    className="flex-1"
                  >
                    {selected.status === 'pending' && (selected.tier ?? 3) <= 2
                      ? 'Approve'
                      : selected.status === 'pending'
                        ? 'Approve (1st)'
                        : 'Approve (Final)'}
                  </Button>
                </div>
              </>
            ) : null}

            {/* Reject-only for rejected/cancelled/completed */}
            {['rejected', 'cancelled', 'sent', 'completed'].includes(selected.status) && (
              <p className="text-text-muted text-sm text-center">This withdrawal has been finalised.</p>
            )}
          </div>
        )}
      </Modal>

      {/* ── Mark Sent Modal ─────────────────────────────────────────────────── */}
      <Modal isOpen={markSentOpen} onClose={() => setMarkSentOpen(false)} title="Mark Withdrawal as Sent" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="p-4 bg-warning/5 border border-warning/20 rounded-xl text-sm">
              <p className="font-medium text-warning mb-1">Final step — confirm the on-chain transaction</p>
              <p className="text-text-secondary">
                Broadcasting <span className="font-bold">{selected.amount} {selected.coin}</span> to{' '}
                <span className="font-mono">{selected.toAddress?.slice(0, 12)}...{selected.toAddress?.slice(-6)}</span> on {selected.network}.
              </p>
              {selected.status === 'auto_approved' && (
                <p className="mt-1.5 text-success text-xs font-medium">
                  Tier 1 — auto-approved (no admin approval required)
                </p>
              )}
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
              <Button variant="secondary" onClick={() => setMarkSentOpen(false)} className="flex-1">Cancel</Button>
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

      {/* ── Confirm modals ──────────────────────────────────────────────────── */}
      <ConfirmModal
        isOpen={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        onConfirm={handleApprove}
        title={selected?.status === 'pending' && (selected?.tier ?? 3) <= 2 ? 'Approve Withdrawal' : selected?.status === 'first_approved' ? 'Final Approval' : 'First Approval'}
        description={
          selected?.status === 'first_approved'
            ? `Provide final approval for ${selected?.amount} ${selected?.coin}? Status will become "Ready to Send."`
            : (selected?.tier ?? 3) <= 2
              ? `Approve ${selected?.amount} ${selected?.coin}? (Tier ${selected?.tier} — single admin approval)`
              : `Provide first approval for ${selected?.amount} ${selected?.coin}? A second admin must still approve before it can be sent.`
        }
        confirmLabel="Approve"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject Withdrawal"
        description={`Reject ${selected?.amount} ${selected?.coin}? Funds will be returned to the user's balance.`}
        confirmLabel="Reject"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={confirmHold}
        onClose={() => setConfirmHold(false)}
        onConfirm={handleHold}
        title="Place on Security Hold"
        description={`Place this ${selected?.amount} ${selected?.coin} withdrawal on hold for manual review?`}
        confirmLabel="Place on Hold"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={handleRelease}
        title="Release Security Hold"
        description={`Release this withdrawal and return it to pending status for normal approval flow?`}
        confirmLabel="Release Hold"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmMarkSent}
        onClose={() => setConfirmMarkSent(false)}
        onConfirm={handleMarkSent}
        title="Confirm Mark as Sent"
        description={`Mark ${selected?.amount} ${selected?.coin} withdrawal as sent with tx ${txHash.slice(0, 16)}...? This cannot be undone.`}
        confirmLabel="Mark as Sent"
        confirmVariant="primary"
      />
    </div>
  )
}

// Helper — avoids inline ternary complexity in the table row
function canMarkSentFor(w: Withdrawal): boolean {
  return w.status === 'approved' || w.status === 'auto_approved'
}
