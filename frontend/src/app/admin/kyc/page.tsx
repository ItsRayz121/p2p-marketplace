'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input } from '@/components/ui/Input'

type KycStatus = 'pending' | 'approved' | 'rejected'

interface KycSubmission {
  id: string
  userId: string
  user?: { email: string; username: string }
  tier: 'basic' | 'enhanced'
  status: KycStatus
  legalName?: string | null
  cnicNumberHash?: string
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  videoUrl?: string | null
  socialLinks?: Array<{ platform: string; url: string }>
  rejectionReason?: string | null
  createdAt: string
  reviewedAt?: string
  cnicDuplicates?: Array<{ userId: string; username: string | null; email: string | null; status: KycStatus }>
}

interface KycQueueResponse {
  submissions: KycSubmission[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

const STATUS_FILTERS = ['all', 'pending', 'approved', 'rejected'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const STATUS_BADGE: Record<KycStatus, 'gold' | 'success' | 'danger'> = {
  pending: 'gold',
  approved: 'success',
  rejected: 'danger',
}

function daysAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

// Loads a KYC document (CNIC/selfie/video) by streaming its bytes through our
// own API origin as an object URL. KYC docs are authenticated Cloudinary assets
// that a direct <img src> can fail to load (CSP / cross-site); the proxy makes
// them render reliably. Falls back to a clear "couldn't load" state on error.
function KycDocImage({
  submissionId, kind, label, isVideo,
}: {
  submissionId: string
  kind: 'front' | 'back' | 'selfie' | 'video'
  label: string
  isVideo?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setStatus('loading')
    setUrl(null)
    adminApi
      .getKycDocUrl(submissionId, kind)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return }
        objectUrl = u
        setUrl(u)
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [submissionId, kind])

  return (
    <div className="space-y-1">
      <p className="text-xs text-text-muted">{label}</p>
      {status === 'loading' && (
        <div className="rounded-lg w-full aspect-video border border-border bg-surface flex items-center justify-center text-xs text-text-muted animate-pulse">
          Loading…
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-lg w-full aspect-video border border-danger/30 bg-danger/5 flex items-center justify-center text-xs text-danger text-center px-2">
          Couldn&apos;t load document
        </div>
      )}
      {status === 'ready' && url && (
        isVideo ? (
          <video src={url} controls className="rounded-lg w-full aspect-video object-contain border border-border bg-surface" />
        ) : (
          <a href={url} target="_blank" rel="noopener noreferrer">
            <img src={url} alt={label} className="rounded-lg w-full aspect-video object-contain border border-border hover:opacity-80 transition-opacity bg-surface" />
          </a>
        )
      )}
    </div>
  )
}

export default function KycQueuePage() {
  const [submissions, setSubmissions] = useState<KycSubmission[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [tierFilter, setTierFilter] = useState<'all' | 'basic' | 'enhanced'>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
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
      const params: Record<string, string | number> = { status: statusFilter, page, limit }
      if (tierFilter !== 'all') params.tier = tierFilter
      if (search) params.search = search
      const data = await adminApi.getKycQueue(params) as KycQueueResponse
      setSubmissions(data.submissions ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load KYC queue')
    } finally {
      setLoading(false)
    }
  }, [page, tierFilter, statusFilter, search])

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
          <p className="text-text-muted text-sm mt-0.5">
            {total} {statusFilter === 'all' ? '' : `${statusFilter} `}submission{total === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {/* Status filter */}
      <div className="admin-toolbar gap-2">
        {STATUS_FILTERS.map((st) => (
          <button
            key={st}
            onClick={() => { setStatusFilter(st); setPage(1) }}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
              statusFilter === st
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {st.charAt(0).toUpperCase() + st.slice(1)}
          </button>
        ))}
      </div>

      {/* Search + tier filter */}
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
                  : 'bg-surface text-text-secondary border-border hover:bg-surface'
              }`}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {submissions.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={statusFilter === 'all' ? 'No KYC submissions' : `No ${statusFilter} KYC submissions`}
          description={statusFilter === 'pending' ? 'All submissions have been reviewed.' : 'Nothing matches the current filters.'}
        />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tier</th>
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
                        <Link href={`/admin/users/${sub.userId}`} className="font-medium text-primary hover:underline">
                          {sub.user?.username || 'Unknown'}
                        </Link>
                        <p className="text-text-muted text-xs">{sub.user?.email}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Tier">
                      <Badge variant={sub.tier === 'enhanced' ? 'gold' : 'default'} size="sm">
                        {sub.tier}
                      </Badge>
                    </td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={STATUS_BADGE[sub.status]} size="sm">
                        {sub.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Submitted">
                      {fmtDate(sub.createdAt)}
                    </td>
                    <td className="px-4 py-3" data-label="Waiting">
                      {sub.status === 'pending' ? (
                        <span className={`text-sm font-medium ${daysAgo(sub.createdAt) > 3 ? 'text-danger' : 'text-text-secondary'}`}>
                          {daysAgo(sub.createdAt)}d
                        </span>
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openReview(sub)}>
                        {sub.status === 'pending' ? 'Review' : 'View'}
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
          selected && selected.status === 'pending' && (
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
              {selected.cnicDuplicates && selected.cnicDuplicates.length > 0 && (
                <div className="px-3 py-2.5 bg-danger/10 border border-danger/30 rounded-lg text-sm">
                  <div className="flex items-center gap-2 font-semibold text-danger">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    Duplicate CNIC — this identity is on {selected.cnicDuplicates.length} other account{selected.cnicDuplicates.length === 1 ? '' : 's'}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {selected.cnicDuplicates.map((d) => (
                      <li key={d.userId} className="text-text-secondary flex flex-wrap items-center gap-x-2">
                        <Link href={`/admin/users/${d.userId}`} className="text-primary hover:underline font-medium">
                          {d.username || d.email || d.userId}
                        </Link>
                        <Badge variant={STATUS_BADGE[d.status]} size="sm">{d.status}</Badge>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-text-muted">
                    The same CNIC number was submitted by these accounts. Approving a CNIC that is already
                    verified on another account is blocked — reject this one unless it is the genuine owner.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-text-muted">User</p>
                  <p className="font-medium text-text-primary">{selected.user?.username}</p>
                  <p className="text-text-secondary">{selected.user?.email}</p>
                </div>
                <div>
                  <p className="text-text-muted">Tier</p>
                  <Badge variant={selected.tier === 'enhanced' ? 'gold' : 'default'}>{selected.tier}</Badge>
                </div>
                <div>
                  <p className="text-text-muted">Status</p>
                  <Badge variant={STATUS_BADGE[selected.status]}>{selected.status}</Badge>
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
                {selected.legalName && (
                  <div>
                    <p className="text-text-muted">Name (as on CNIC)</p>
                    <p className="font-medium text-text-primary">{selected.legalName}</p>
                    <p className="text-xs text-text-muted">Compare against the CNIC image before approving.</p>
                  </div>
                )}
              </div>

              {/* Document previews */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-primary">Documents</p>
                <div className="grid grid-cols-3 gap-3">
                  {selected.frontUrl && (
                    <KycDocImage submissionId={selected.id} kind="front" label="CNIC Front" />
                  )}
                  {selected.backUrl && (
                    <KycDocImage submissionId={selected.id} kind="back" label="CNIC Back" />
                  )}
                  {selected.selfieUrl && (
                    <KycDocImage submissionId={selected.id} kind="selfie" label="Selfie" />
                  )}
                  {selected.videoUrl && (
                    <KycDocImage submissionId={selected.id} kind="video" label="Verification Video" isVideo />
                  )}
                  {!selected.frontUrl && !selected.backUrl && !selected.selfieUrl && (
                    <p className="text-sm text-text-muted col-span-3">No documents uploaded</p>
                  )}
                </div>
                {selected.socialLinks && selected.socialLinks.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-text-muted mb-1">Social Profiles</p>
                    <ul className="space-y-1">
                      {selected.socialLinks.map((l, i) => (
                        <li key={i} className="text-sm">
                          <span className="text-text-muted">{l.platform}:</span>{' '}
                          <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{l.url}</a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Already-reviewed submissions are read-only */}
              {selected.status !== 'pending' && (
                <div className="px-3 py-2 bg-surface border border-border rounded-lg text-sm space-y-1">
                  <p className="text-text-secondary">
                    This submission was <span className="font-medium text-text-primary">{selected.status}</span>
                    {selected.reviewedAt ? ` on ${fmtDateTime(selected.reviewedAt)}` : ''}.
                  </p>
                  {selected.status === 'rejected' && selected.rejectionReason && (
                    <p className="text-text-secondary">
                      <span className="text-text-muted">Reason:</span> {selected.rejectionReason}
                    </p>
                  )}
                </div>
              )}

              {/* Notes for approval */}
              {selected.status === 'pending' && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">
                    Approval Notes <span className="text-text-muted font-normal">(optional)</span>
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="Add notes for the user..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                </div>
              )}

              {/* Reject reason */}
              {selected.status === 'pending' && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">
                    Rejection Reason <span className="text-text-muted font-normal">(required if rejecting)</span>
                  </label>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={2}
                    placeholder="Explain why the submission is being rejected..."
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                </div>
              )}

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

