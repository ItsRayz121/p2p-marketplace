'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input } from '@/components/ui/Input'

interface KycSubmission {
  id: string
  userId: string
  user?: { email: string; username: string }
  level: 'basic' | 'enhanced'
  status: 'pending' | 'approved' | 'rejected'
  cnicNumberHash?: string
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  createdAt: string
  reviewedAt?: string
}

interface KycQueueResponse {
  submissions: KycSubmission[]
  total: number
  page: number
}

function daysAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

export default function KycQueuePage() {
  const [submissions, setSubmissions] = useState<KycSubmission[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [tierFilter, setTierFilter] = useState<'all' | 'basic' | 'enhanced'>('all')
  const [search, setSearch] = useState('')

  const [selected, setSelected] = useState<KycSubmission | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const limit = 20

  const fetchQueue = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { status: 'pending', page, limit }
      if (tierFilter !== 'all') params.level = tierFilter
      if (search) params.search = search
      const data = await adminApi.getKycQueue(params) as KycQueueResponse
      setSubmissions(data.submissions ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load KYC queue')
    } finally {
      setLoading(false)
    }
  }, [page, tierFilter, search])

  usePolling(fetchQueue, 30_000)

  function openReview(sub: KycSubmission) {
    setSelected(sub)
    setNotes('')
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
  }

  async function handleApprove() {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    try {
      await adminApi.approveKyc(selected.id, { notes })
      setConfirmApprove(false)
      setModalOpen(false)
      fetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReject() {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    try {
      await adminApi.rejectKyc(selected.id, { reason: rejectReason })
      setConfirmReject(false)
      setModalOpen(false)
      fetchQueue()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject')
    } finally {
      setActionLoading(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading KYC queue..." />
  if (error && submissions.length === 0) return <ErrorState title={error} onRetry={fetchQueue} />

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">KYC Queue</h1>
          <p className="text-text-muted text-sm mt-0.5">{total} pending submissions</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 bg-surface shadow-card p-4 rounded-xl border border-border">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search by email or username..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <div className="flex gap-2">
          {(['all', 'basic', 'enhanced'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTierFilter(t); setPage(1) }}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                tierFilter === t
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white text-text-secondary border-border hover:bg-surface'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {submissions.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No pending KYC submissions" description="All submissions have been reviewed." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tier</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Submitted</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Waiting</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {submissions.map((sub) => (
                  <tr key={sub.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{sub.user?.username || 'Unknown'}</p>
                      <p className="text-text-muted text-xs">{sub.user?.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={sub.level === 'enhanced' ? 'gold' : 'default'} size="sm">
                        {sub.level}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {fmtDate(sub.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${daysAgo(sub.createdAt) > 3 ? 'text-danger' : 'text-text-secondary'}`}>
                        {daysAgo(sub.createdAt)}d
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openReview(sub)}>
                        Review
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
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
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="KYC Review"
        size="lg"
        footer={
          selected && (
            <div className="flex gap-3">
              <Button
                variant="danger"
                onClick={() => { if (rejectReason.trim()) setConfirmReject(true) }}
                disabled={!rejectReason.trim() || actionLoading}
                className="flex-1"
              >
                Reject
              </Button>
              <Button
                variant="primary"
                onClick={() => setConfirmApprove(true)}
                disabled={actionLoading}
                className="flex-1"
              >
                Approve
              </Button>
            </div>
          )
        }
      >
        {selected && (
          <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-text-muted">User</p>
                  <p className="font-medium text-text-primary">{selected.user?.username}</p>
                  <p className="text-text-secondary">{selected.user?.email}</p>
                </div>
                <div>
                  <p className="text-text-muted">Tier</p>
                  <Badge variant={selected.level === 'enhanced' ? 'gold' : 'default'}>{selected.level}</Badge>
                </div>
                <div>
                  <p className="text-text-muted">Submitted</p>
                  <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
                </div>
                <div>
                  <p className="text-text-muted">CNIC Hash (partial)</p>
                  <p className="font-mono text-xs text-text-secondary break-all">
                    {selected.cnicNumberHash
                      ? '*****' + selected.cnicNumberHash.slice(-4)
                      : 'N/A'}
                  </p>
                </div>
              </div>

              {/* Document previews */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-primary">Documents</p>
                <div className="grid grid-cols-3 gap-3">
                  {selected.frontUrl && (
                    <div className="space-y-1">
                      <p className="text-xs text-text-muted">CNIC Front</p>
                      <a href={selected.frontUrl} target="_blank" rel="noopener noreferrer">
                        <img src={selected.frontUrl} alt="CNIC Front" className="rounded-lg w-full aspect-video object-contain border border-border hover:opacity-80 transition-opacity bg-surface" />
                      </a>
                    </div>
                  )}
                  {selected.backUrl && (
                    <div className="space-y-1">
                      <p className="text-xs text-text-muted">CNIC Back</p>
                      <a href={selected.backUrl} target="_blank" rel="noopener noreferrer">
                        <img src={selected.backUrl} alt="CNIC Back" className="rounded-lg w-full aspect-video object-contain border border-border hover:opacity-80 transition-opacity bg-surface" />
                      </a>
                    </div>
                  )}
                  {selected.selfieUrl && (
                    <div className="space-y-1">
                      <p className="text-xs text-text-muted">Selfie</p>
                      <a href={selected.selfieUrl} target="_blank" rel="noopener noreferrer">
                        <img src={selected.selfieUrl} alt="Selfie" className="rounded-lg w-full aspect-video object-contain border border-border hover:opacity-80 transition-opacity bg-surface" />
                      </a>
                    </div>
                  )}
                  {!selected.frontUrl && !selected.backUrl && !selected.selfieUrl && (
                    <p className="text-sm text-text-muted col-span-3">No documents uploaded</p>
                  )}
                </div>
              </div>

              {/* Notes for approval */}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Approval Notes <span className="text-text-muted font-normal">(optional)</span>
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Add notes for the user..."
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>

              {/* Reject reason */}
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Rejection Reason <span className="text-text-muted font-normal">(required if rejecting)</span>
                </label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                  placeholder="Explain why the submission is being rejected..."
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                />
              </div>

              {actionError && (
                <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                  {actionError}
                </div>
              )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmApprove}
        onClose={() => setConfirmApprove(false)}
        onConfirm={handleApprove}
        title="Approve KYC"
        description={`Approve KYC submission for ${selected?.user?.email}? This will update their KYC status.`}
        confirmLabel="Approve"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject KYC"
        description={`Reject this KYC submission? The user will be notified with the reason you provided.`}
        confirmLabel="Reject"
        confirmVariant="danger"
      />
    </div>
  )
}

