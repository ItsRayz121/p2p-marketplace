'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Building2 } from 'lucide-react'

const MERCHANT_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
}
const merchantStatusLabel = (s: string) => MERCHANT_STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface MerchantKycSubmission {
  id: string
  userId: string
  user?: { email: string; username: string }
  businessName?: string
  description?: string
  proofUrl?: string
  status: 'pending' | 'approved' | 'rejected'
  notes?: string
  createdAt: string
  reviewedAt?: string
}

interface MerchantKycResponse {
  submissions: MerchantKycSubmission[]
  total: number
}

function daysAgo(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24))
}

export default function MerchantKycPage() {
  const [submissions, setSubmissions] = useState<MerchantKycSubmission[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('pending')

  const [selected, setSelected] = useState<MerchantKycSubmission | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const limit = 20

  const fetchQueue = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getMerchantKycQueue(params) as MerchantKycResponse
      setSubmissions(data.submissions ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load merchant KYC queue')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchQueue, 30_000)

  function openModal(sub: MerchantKycSubmission) {
    setSelected(sub)
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
  }

  async function handleApprove() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.approveMerchantKyc(selected.id)
      setConfirmApprove(false)
      setModalOpen(false)
      fetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve merchant KYC')
    }
  }

  async function handleReject() {
    if (!selected) return
    setActionError(null)
    try {
      await adminApi.rejectMerchantKyc(selected.id, { reason: rejectReason })
      setConfirmReject(false)
      setModalOpen(false)
      fetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject merchant KYC')
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading merchant KYC queue..." />
  if (error && submissions.length === 0) return <ErrorState title={error} onRetry={fetchQueue} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Trader Verification</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} merchant applications</p>
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border admin-toolbar gap-2">
        {['pending', 'approved', 'rejected', 'all'].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border capitalize ${
              statusFilter === s
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {submissions.length === 0 ? (
        <EmptyState icon={Building2} title="No merchant KYC applications" description="No applications match the current filter." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Business</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Submitted</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Waiting</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {submissions.map((sub) => (
                  <tr key={sub.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3" data-label="User">
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{sub.user?.username || 'Unknown'}</p>
                        <p className="text-xs text-text-muted">{sub.user?.email}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Business">
                      <div className="min-w-0">
                        <p className="text-text-primary">{sub.businessName || '—'}</p>
                        {sub.description && (
                          <p className="text-xs text-text-muted truncate sm:max-w-xs">{sub.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge
                        variant={sub.status === 'approved' ? 'success' : sub.status === 'rejected' ? 'danger' : 'warning'}
                        size="sm"
                      >
                        {merchantStatusLabel(sub.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Submitted">{fmtDate(sub.createdAt)}</td>
                    <td className="px-4 py-3" data-label="Waiting">
                      <span className={`text-sm font-medium ${daysAgo(sub.createdAt) > 3 ? 'text-danger' : 'text-text-secondary'}`}>
                        {daysAgo(sub.createdAt)}d
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(sub)}>Review</Button>
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
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Trader Verification Review" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">Applicant</p>
                <p className="font-medium text-text-primary">{selected.user?.username}</p>
                <p className="text-xs text-text-muted">{selected.user?.email}</p>
              </div>
              <div>
                <p className="text-text-muted">Business Name</p>
                <p className="text-text-primary">{selected.businessName || '—'}</p>
              </div>
              <div className="col-span-2">
                <p className="text-text-muted">Description</p>
                <p className="text-text-secondary">{selected.description || '—'}</p>
              </div>
              <div>
                <p className="text-text-muted">Submitted</p>
                <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
              </div>
              <div>
                <p className="text-text-muted">Current Status</p>
                <Badge
                  variant={selected.status === 'approved' ? 'success' : selected.status === 'rejected' ? 'danger' : 'warning'}
                >
                  {merchantStatusLabel(selected.status)}
                </Badge>
              </div>
            </div>

            {selected.proofUrl && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Business Proof Document</p>
                <a
                  href={selected.proofUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-surface text-sm text-primary"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  View Document
                </a>
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
                placeholder="Why is this merchant application being rejected?"
                className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
              />
            </div>

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            {selected.status === 'pending' && (
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
                  onClick={() => setConfirmApprove(true)}
                  className="flex-1"
                >
                  Approve Merchant
                </Button>
              </div>
            )}

            {selected.status !== 'pending' && (
              <div className="px-4 py-3 bg-surface rounded-xl text-sm text-text-muted text-center">
                This application has already been {merchantStatusLabel(selected.status)}.
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        onConfirm={handleApprove}
        title="Approve Merchant Application"
        description={`Grant merchant status to ${selected?.user?.email}? They will be able to post ads and access merchant features.`}
        confirmLabel="Approve Merchant"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject Merchant Application"
        description="Reject this merchant application? The user will be notified with your reason."
        confirmLabel="Reject"
        confirmVariant="danger"
      />
    </div>
  )
}

