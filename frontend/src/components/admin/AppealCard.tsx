'use client'
import { useState } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

export interface AppealItem {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'more_info_requested'
  subjectStatus: string
  explanation: string
  evidenceUrls: string[]
  decisionNote: string | null
  reviewedAt: string | null
  createdAt: string
  user?: { id: string; username: string; email: string; moderationStatus?: string }
  reviewedBy?: { id: string; username: string } | null
}

const STATUS_VARIANT: Record<AppealItem['status'], 'warning' | 'success' | 'danger' | 'info'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  more_info_requested: 'info',
}
const STATUS_LABEL: Record<AppealItem['status'], string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  more_info_requested: 'Info Requested',
}

export function AppealCard({ appeal, onChange, showUser = true }: { appeal: AppealItem; onChange?: () => void; showUser?: boolean }) {
  const [action, setAction] = useState<null | 'approve' | 'reject' | 'request-info'>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = appeal.status === 'pending' || appeal.status === 'more_info_requested'

  async function submit() {
    setBusy(true); setError(null)
    try {
      if (action === 'approve') await adminApi.approveAppeal(appeal.id, note ? { note } : {})
      else if (action === 'reject') {
        if (!note.trim()) { setError('A decision note is required'); setBusy(false); return }
        await adminApi.rejectAppeal(appeal.id, { note: note.trim() })
      } else if (action === 'request-info') {
        if (!note.trim()) { setError('A note is required'); setBusy(false); return }
        await adminApi.requestAppealInfo(appeal.id, { note: note.trim() })
      }
      setAction(null); setNote('')
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-border rounded-xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {showUser && appeal.user && (
            <Link href={`/admin/users/${appeal.user.id}`} className="text-primary hover:underline font-medium text-sm">{appeal.user.username}</Link>
          )}
          {showUser && appeal.user && <span className="text-xs text-text-muted">{appeal.user.email}</span>}
          <Badge variant={STATUS_VARIANT[appeal.status]} size="sm">{STATUS_LABEL[appeal.status]}</Badge>
          <Badge variant="default" size="sm">{appeal.subjectStatus.replace(/_/g, ' ')}</Badge>
        </div>
        <span className="text-xs text-text-muted">{fmtDateTime(appeal.createdAt)}</span>
      </div>

      <p className="text-sm text-text-secondary whitespace-pre-wrap">{appeal.explanation}</p>

      {appeal.evidenceUrls?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {appeal.evidenceUrls.map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="block w-16 h-16 rounded-lg overflow-hidden border border-border hover:ring-2 hover:ring-primary">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`Evidence ${i + 1}`} className="w-full h-full object-cover" />
            </a>
          ))}
        </div>
      )}

      {appeal.decisionNote && (
        <div className="text-xs bg-surface-alt rounded-lg px-3 py-2">
          <span className="text-text-muted">Decision note: </span>
          <span className="text-text-secondary">{appeal.decisionNote}</span>
          {appeal.reviewedBy && <span className="text-text-muted"> — {appeal.reviewedBy.username}</span>}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {open && (
        action ? (
          <div className="space-y-2">
            {action !== 'approve' && (
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={action === 'reject' ? 'Reason for rejection (shown to user, required)' : 'What information is needed? (shown to user, required)'} className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
            )}
            {action === 'approve' && (
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional note (shown to user)" className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
            )}
            <div className="flex gap-2">
              <Button size="sm" variant={action === 'reject' ? 'danger' : 'primary'} loading={busy} onClick={submit}>
                Confirm {action === 'approve' ? 'Approval' : action === 'reject' ? 'Rejection' : 'Request'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setAction(null); setNote(''); setError(null) }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => setAction('approve')}>Approve & Restore</Button>
            <Button size="sm" variant="danger" onClick={() => setAction('reject')}>Reject</Button>
            <Button size="sm" variant="secondary" onClick={() => setAction('request-info')}>Request Info</Button>
          </div>
        )
      )}
    </div>
  )
}
