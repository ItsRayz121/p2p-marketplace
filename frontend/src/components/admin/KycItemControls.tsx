'use client'

import { useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import type { KycItemStatus } from '@/lib/api'

const STATUS_TEXT: Record<KycItemStatus, { text: string; cls: string }> = {
  pending: { text: 'To review', cls: 'text-text-muted' },
  approved: { text: 'Approved', cls: 'text-success' },
  resubmit: { text: 'Sent back', cls: 'text-warning' },
  rejected: { text: 'Rejected', cls: 'text-danger' },
  resubmitted: { text: 'Sent again', cls: 'text-primary' },
}

/**
 * Three small actions for ONE document or answer: approve, ask for it again, or reject it. Saving a
 * decision does not close the review, so the reviewer can go through every item and then act once.
 */
export function KycItemControls({
  label, status, reason, locked, busy, onDecide,
}: {
  label: string
  status: KycItemStatus
  reason?: string | null
  /** The part this item belongs to is already decided. */
  locked: boolean
  busy?: boolean
  onDecide: (status: 'approved' | 'resubmit' | 'rejected', reason?: string) => Promise<void> | void
}) {
  const [asking, setAsking] = useState<'resubmit' | 'rejected' | null>(null)
  const [why, setWhy] = useState('')
  const s = STATUS_TEXT[status]
  const btn = 'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed'

  async function save() {
    if (!asking || !why.trim()) return
    await onDecide(asking, why.trim())
    setAsking(null)
    setWhy('')
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`text-[11px] font-medium ${s.cls}`} data-testid={`kyc-status-${label}`}>{s.text}</span>
        {!locked && (
          <span className="ml-auto inline-flex gap-1">
            <button type="button" className={`${btn} hover:text-success`} title="Approve" aria-label={`Approve ${label}`} disabled={busy || status === 'approved'} onClick={() => void onDecide('approved')}>
              <Check className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={`${btn} hover:text-warning`} title="Ask for this again" aria-label={`Request resubmission of ${label}`} disabled={busy} onClick={() => setAsking('resubmit')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={`${btn} hover:text-danger`} title="Reject this item" aria-label={`Reject ${label}`} disabled={busy} onClick={() => setAsking('rejected')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {reason && (status === 'resubmit' || status === 'rejected') && <p className="text-[11px] text-text-muted break-words">{reason}</p>}
      {asking && (
        <div className="flex gap-1.5">
          <input
            autoFocus value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setAsking(null) }}
            aria-label={`Reason for ${label}`} placeholder={asking === 'resubmit' ? 'What should they send again?' : 'Why is this rejected?'}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button type="button" onClick={() => void save()} disabled={!why.trim() || busy} className="rounded-md bg-primary px-2 text-xs font-semibold text-white disabled:opacity-50">Save</button>
          <button type="button" onClick={() => setAsking(null)} className="rounded-md border border-border px-2 text-xs text-text-secondary">Cancel</button>
        </div>
      )}
    </div>
  )
}
