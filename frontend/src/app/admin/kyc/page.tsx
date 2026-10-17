'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi, type KycPartState, type KycReviewItem } from '@/lib/api'
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
import { KycDocImage } from '@/components/admin/KycDocImage'
import { KycItemControls } from '@/components/admin/KycItemControls'

type KycStatus = 'pending' | 'approved' | 'rejected'

interface KycSubmission {
  id: string
  userId: string
  user?: { email: string; username: string }
  tier: 'basic' | 'enhanced'
  status: KycStatus
  basicState?: KycPartState
  enhancedState?: KycPartState
  items?: KycReviewItem[]
  legalName?: string | null
  cnicNumberHash?: string
  idType?: 'national_id' | 'passport'
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  videoUrl?: string | null
  whatsappNumber?: string | null
  communityLinks?: Array<{ url: string }>
  referenceUrl?: string | null
  socialLinks?: Array<{ platform: string; url: string }>
  rejectionReason?: string | null
  createdAt: string
  reviewedAt?: string
  cnicDuplicates?: Array<{ userId: string; username: string | null; email: string | null; status: KycStatus }>
  whatsappDuplicates?: Array<{ userId: string; username: string | null; email: string | null }>
  communityDuplicates?: Array<{ userId: string; username: string | null; email: string | null; url: string }>
}

interface KycQueueResponse {
  submissions: KycSubmission[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

const STATUS_FILTERS = ['all', 'pending', 'waiting', 'approved', 'rejected'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const FILTER_LABEL: Record<string, string> = { waiting: 'Waiting for user' }

const PART_BADGE: Record<KycPartState, 'gold' | 'success' | 'danger' | 'default'> = {
  pending: 'gold', changes_requested: 'default', approved: 'success', rejected: 'danger', not_requested: 'default',
}
const PART_TEXT: Record<KycPartState, string> = {
  pending: 'Pending', changes_requested: 'Changes required', approved: 'Verified', rejected: 'Rejected', not_requested: 'Not requested',
}

const STATUS_BADGE: Record<KycStatus, 'gold' | 'success' | 'danger'> = {
  pending: 'gold',
  approved: 'success',
  rejected: 'danger',
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')

  const [selected, setSelected] = useState<KycSubmission | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [confirmReject, setConfirmReject] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [itemBusy, setItemBusy] = useState(false)
  const [confirmPart, setConfirmPart] = useState<'basic' | 'enhanced' | 'all' | null>(null)
  const [confirmChanges, setConfirmChanges] = useState(false)
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

  async function loadDetail(id: string) {
    const detail = await adminApi.getKycSubmission(id) as KycSubmission
    setSelected(detail)
    return detail
  }

  function openReview(sub: KycSubmission) {
    setSelected(sub)
    setNotes('')
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
    // The queue row has no per-item review state: load the full submission.
    loadDetail(sub.id).catch((err) => setActionError(err instanceof Error ? err.message : 'Failed to load the submission'))
  }

  /** Save one item decision at once, then show the refreshed state. */
  async function decideItem(item: string, status: 'approved' | 'resubmit' | 'rejected', reason?: string) {
    if (!selected) return
    setItemBusy(true)
    setActionError(null)
    try {
      await adminApi.reviewKycItem(selected.id, item, { status, ...(reason ? { reason } : {}) })
      await loadDetail(selected.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not save that decision')
    } finally {
      setItemBusy(false)
    }
  }

  async function afterAction(id: string) {
    fetchQueue()
    try {
      const d = await loadDetail(id)
      if (d.status !== 'pending') setModalOpen(false)
    } catch { setModalOpen(false) }
  }

  async function handleApprovePart() {
    if (!selected || !confirmPart) return
    setActionLoading(true)
    setActionError(null)
    try {
      if (confirmPart === 'all') await adminApi.approveKyc(selected.id, { notes })
      else await adminApi.approveKycPart(selected.id, confirmPart)
      setConfirmPart(null)
      await afterAction(selected.id)
    } catch (err) {
      setConfirmPart(null)
      setActionError(err instanceof Error ? err.message : 'Failed to approve')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRequestChanges() {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    try {
      await adminApi.requestKycChanges(selected.id)
      setConfirmChanges(false)
      await afterAction(selected.id)
    } catch (err) {
      setConfirmChanges(false)
      setActionError(err instanceof Error ? err.message : 'Failed to send the request')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleReject() {
    if (!selected) return
    setActionLoading(true)
    setActionError(null)
    try {
      await adminApi.rejectKyc(selected.id, { reason: rejectReason, part: 'all' })
      setConfirmReject(false)
      await afterAction(selected.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject')
    } finally {
      setActionLoading(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  /** Small approve / send-again / reject actions for one item, shown only when the item exists. */
  function itemControls(item: string, label: string) {
    const it = selected?.items?.find((i) => i.item === item)
    if (!selected || !it || selected.status !== 'pending') return null
    const locked = (it.part === 'basic' ? selected.basicState : selected.enhancedState) === 'approved'
      || (it.part === 'basic' ? selected.basicState : selected.enhancedState) === 'rejected'
    return <KycItemControls label={label} status={it.status} reason={it.reason} locked={locked} busy={itemBusy} onDecide={(st, why) => decideItem(item, st, why)} />
  }

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
            {FILTER_LABEL[st] ?? st.charAt(0).toUpperCase() + st.slice(1)}
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
                      {sub.status === 'pending' && sub.basicState ? (
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={PART_BADGE[sub.basicState]} size="sm">Basic: {PART_TEXT[sub.basicState]}</Badge>
                          {sub.enhancedState && sub.enhancedState !== 'not_requested' && (
                            <Badge variant={PART_BADGE[sub.enhancedState]} size="sm">Enhanced: {PART_TEXT[sub.enhancedState]}</Badge>
                          )}
                        </div>
                      ) : (
                        <Badge variant={STATUS_BADGE[sub.status]} size="sm">
                          {sub.status}
                        </Badge>
                      )}
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
          selected && selected.status === 'pending' && (() => {
            const items = selected.items ?? []
            const flagged = items.filter((i) => i.status === 'resubmit' || i.status === 'rejected')
            const basicOpen = selected.basicState === 'pending' || selected.basicState === 'changes_requested'
            const enhancedOpen = selected.enhancedState === 'pending' || selected.enhancedState === 'changes_requested'
            const basicFlagged = flagged.some((i) => i.part === 'basic')
            const enhancedFlagged = flagged.some((i) => i.part === 'enhanced')
            const canAsk = flagged.some((i) => (i.part === 'basic' && selected.basicState === 'pending') || (i.part === 'enhanced' && selected.enhancedState === 'pending'))
            return (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  onClick={() => { if (rejectReason.trim()) setConfirmReject(true) }}
                  disabled={!rejectReason.trim() || actionLoading}
                  title={rejectReason.trim() ? undefined : 'Write a rejection reason first'}
                >
                  Reject
                </Button>
                {canAsk && (
                  <Button variant="secondary" onClick={() => setConfirmChanges(true)} disabled={actionLoading}>
                    Send change request
                  </Button>
                )}
                {basicOpen && (
                  <Button
                    variant="primary" className="flex-1"
                    onClick={() => setConfirmPart('basic')}
                    disabled={actionLoading || itemBusy || basicFlagged}
                    title={basicFlagged ? 'Some identity items still need changes' : undefined}
                  >
                    Approve Basic
                  </Button>
                )}
                {enhancedOpen && selected.basicState !== 'approved' && basicOpen && !basicFlagged && !enhancedFlagged && (
                  <Button variant="primary" onClick={() => setConfirmPart('all')} disabled={actionLoading || itemBusy}>
                    Approve Basic + Enhanced
                  </Button>
                )}
                {enhancedOpen && selected.basicState === 'approved' && (
                  <Button
                    variant="primary" className="flex-1"
                    onClick={() => setConfirmPart('enhanced')}
                    disabled={actionLoading || itemBusy || enhancedFlagged}
                    title={enhancedFlagged ? 'Some Enhanced items still need changes' : undefined}
                  >
                    Approve Enhanced
                  </Button>
                )}
              </div>
            )
          })()
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

              {((selected.whatsappDuplicates?.length ?? 0) > 0 || (selected.communityDuplicates?.length ?? 0) > 0) && (
                <div className="px-3 py-2.5 bg-warning/10 border border-warning/30 rounded-lg text-sm">
                  <div className="flex items-center gap-2 font-semibold text-warning">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    Contact details shared with another account
                  </div>
                  <ul className="mt-1.5 space-y-1 text-text-secondary">
                    {(selected.whatsappDuplicates ?? []).map((d) => (
                      <li key={`wa-${d.userId}`} className="flex flex-wrap items-center gap-x-2">
                        <span className="text-text-muted">Same WhatsApp number:</span>
                        <Link href={`/admin/users/${d.userId}`} className="text-primary hover:underline font-medium">{d.username || d.email || d.userId}</Link>
                      </li>
                    ))}
                    {(selected.communityDuplicates ?? []).map((d) => (
                      <li key={`cm-${d.userId}-${d.url}`} className="flex flex-wrap items-center gap-x-2">
                        <span className="text-text-muted">Same community link:</span>
                        <Link href={`/admin/users/${d.userId}`} className="text-primary hover:underline font-medium">{d.username || d.email || d.userId}</Link>
                        <span className="text-xs text-text-muted break-all">{d.url}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-text-muted">
                    This can mean one person runs several accounts. It can also be innocent (a shared business number,
                    or a big public group). Check before approving.
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
                  <p className="text-text-muted">Verification</p>
                  {selected.basicState ? (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      <Badge variant={PART_BADGE[selected.basicState]}>Basic: {PART_TEXT[selected.basicState]}</Badge>
                      {selected.enhancedState && selected.enhancedState !== 'not_requested' && (
                        <Badge variant={PART_BADGE[selected.enhancedState]}>Enhanced: {PART_TEXT[selected.enhancedState]}</Badge>
                      )}
                    </div>
                  ) : (
                    <Badge variant={STATUS_BADGE[selected.status]}>{selected.status}</Badge>
                  )}
                </div>
                <div>
                  <p className="text-text-muted">Submitted</p>
                  <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
                </div>
                <div>
                  <p className="text-text-muted">Document type</p>
                  <p className="text-text-secondary">{selected.idType === 'passport' ? 'Passport (photo page only)' : 'National ID (front + back)'}</p>
                </div>
                <div>
                  <p className="text-text-muted">ID number hash (partial)</p>
                  <p className="font-mono text-xs text-text-secondary break-all">
                    {selected.cnicNumberHash
                      ? '*****' + selected.cnicNumberHash.slice(-4)
                      : 'N/A'}
                  </p>
                </div>
                {selected.legalName && (
                  <div>
                    <p className="text-text-muted">Name (as on ID / passport)</p>
                    <p className="font-medium text-text-primary">{selected.legalName}</p>
                    <p className="text-xs text-text-muted">Compare against the document image before approving.</p>
                    {itemControls('legal_name', 'name')}
                  </div>
                )}
              </div>

              {/* Document previews */}
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-primary">Documents</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {selected.frontUrl && (
                    <div>
                      <KycDocImage submissionId={selected.id} kind="front" label={selected.idType === 'passport' ? 'Passport page' : 'ID Front'} />
                      {itemControls('id_front', selected.idType === 'passport' ? 'passport page' : 'ID front')}
                    </div>
                  )}
                  {selected.backUrl && (
                    <div>
                      <KycDocImage submissionId={selected.id} kind="back" label="ID Back" />
                      {itemControls('id_back', 'ID back')}
                    </div>
                  )}
                  {selected.selfieUrl && (
                    <div>
                      <KycDocImage submissionId={selected.id} kind="selfie" label="Selfie" />
                      {itemControls('selfie', 'selfie')}
                    </div>
                  )}
                  {selected.videoUrl && (
                    <KycDocImage submissionId={selected.id} kind="video" label="Verification Video" isVideo />
                  )}
                  {!selected.frontUrl && !selected.backUrl && !selected.selfieUrl && (
                    <p className="text-sm text-text-muted col-span-3">No documents uploaded</p>
                  )}
                </div>
                {selected.tier === 'enhanced' && (
                  <div className="mt-3 rounded-lg border border-border bg-surface p-3 space-y-2">
                    <p className="text-xs font-semibold text-text-primary">Ad posting answers (Level 2)</p>
                    <div>
                      <p className="text-sm"><span className="text-text-muted">WhatsApp:</span> {selected.whatsappNumber ?? 'Not provided'}</p>
                      {itemControls('whatsapp', 'WhatsApp number')}
                    </div>
                    <div>
                      <p className="text-xs text-text-muted mb-0.5">Community (open it and check it is real and active)</p>
                      {(selected.communityLinks ?? []).length > 0 ? (
                        <ul className="space-y-0.5">
                          {(selected.communityLinks ?? []).map((l, i) => (
                            <li key={i} className="text-sm"><a href={l.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{l.url}</a></li>
                          ))}
                        </ul>
                      ) : <p className="text-sm text-text-muted">None provided</p>}
                      {itemControls('community', 'community link')}
                    </div>
                    <p className="text-sm">
                      <span className="text-text-muted">Trusted reference:</span>{' '}
                      {selected.referenceUrl
                        ? <a href={selected.referenceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{selected.referenceUrl}</a>
                        : <span className="text-text-muted">None</span>}
                    </p>
                    {selected.referenceUrl && itemControls('reference', 'trusted reference')}
                    <p className="text-[11px] text-text-muted">Approving Enhanced also approves the user as a maker.</p>
                  </div>
                )}
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
                    {itemControls('social', 'social profiles')}
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
        isOpen={confirmPart !== null}
        onClose={() => setConfirmPart(null)}
        onConfirm={handleApprovePart}
        title={confirmPart === 'basic' ? 'Approve Basic KYC' : confirmPart === 'enhanced' ? 'Approve Enhanced KYC' : 'Approve Basic + Enhanced'}
        description={
          confirmPart === 'basic'
            ? `Approve the identity (Basic) of ${selected?.user?.email}? Anything about Enhanced stays as it is.`
            : confirmPart === 'enhanced'
              ? `Approve Enhanced for ${selected?.user?.email}? This also approves them as a maker.`
              : `Approve both Basic and Enhanced for ${selected?.user?.email}? This also approves them as a maker.`
        }
        confirmLabel="Approve"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmChanges}
        onClose={() => setConfirmChanges(false)}
        onConfirm={handleRequestChanges}
        title="Send change request"
        description="The user is told exactly which items to send again, with your reasons. Everything you approved stays approved."
        confirmLabel="Send request"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject KYC"
        description={selected?.basicState === 'approved' ? 'Reject the Enhanced request? Their approved Basic verification is kept. The user is told the reason.' : 'Reject this KYC submission? The user will be notified with the reason you provided.'}
        confirmLabel="Reject"
        confirmVariant="danger"
      />
    </div>
  )
}

