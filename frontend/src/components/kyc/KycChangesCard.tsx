'use client'

import { useState } from 'react'
import { kycApi, type KycResubmitFields, type KycReview, type KycReviewItem } from '@/lib/api'
import { useFileUpload } from '@/hooks/useFileUpload'

const STATE_TEXT: Record<string, string> = {
  pending: 'Under review', changes_requested: 'Changes required', approved: 'Verified', rejected: 'Rejected', not_requested: '',
}

const FILE_ITEMS: Record<string, { field: 'frontUrl' | 'backUrl' | 'selfieUrl'; type: 'kyc-front' | 'kyc-back' | 'kyc-selfie' }> = {
  id_front: { field: 'frontUrl', type: 'kyc-front' },
  id_back: { field: 'backUrl', type: 'kyc-back' },
  selfie: { field: 'selfieUrl', type: 'kyc-selfie' },
}

const TEXT_HINT: Record<string, { placeholder: string; type?: string }> = {
  legal_name: { placeholder: 'Full name exactly as printed on your ID or passport' },
  whatsapp: { placeholder: '+923001234567' },
  community: { placeholder: 'https://chat.whatsapp.com/… or https://t.me/…', type: 'url' },
  reference: { placeholder: 'https://…', type: 'url' },
  social: { placeholder: 'https://www.facebook.com/…', type: 'url' },
}

export const isFlagged = (i: KycReviewItem) => i.status === 'resubmit' || i.status === 'rejected'

function FileItem({ type, onUploaded }: { type: 'kyc-front' | 'kyc-back' | 'kyc-selfie'; onUploaded: (url: string) => void }) {
  const { upload, uploading, error } = useFileUpload(type)
  const [done, setDone] = useState(false)
  return (
    <div className="space-y-1">
      <input
        type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading}
        aria-label="Choose a new photo"
        className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (!f) return
          setDone(false)
          try { onUploaded(await upload(f)); setDone(true) } catch { /* error shown below */ }
        }}
      />
      {uploading && <p className="text-xs text-text-muted">Uploading…</p>}
      {done && <p className="text-xs text-success">Uploaded. Press “Send changes” below.</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  )
}

/**
 * Shown when a reviewer sent something back. Only the flagged items can be replaced: everything that
 * was approved stays approved and is not asked for again.
 */
export function KycChangesCard({ submissionId, review, onSent }: { submissionId: string; review: KycReview; onSent: () => void }) {
  const flagged = review.items.filter(isFlagged)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const set = (item: string, v: string) => setValues((s) => ({ ...s, [item]: v }))

  if (flagged.length === 0) return null

  async function send() {
    const fields: KycResubmitFields = {}
    for (const i of flagged) {
      const v = (values[i.item] ?? '').trim()
      if (!v) continue
      if (FILE_ITEMS[i.item]) fields[FILE_ITEMS[i.item]!.field] = v
      else if (i.item === 'legal_name') fields.legalName = v
      else if (i.item === 'whatsapp') fields.whatsappNumber = v
      else if (i.item === 'community') fields.communityLinks = [{ url: v }]
      else if (i.item === 'reference') fields.referenceUrl = v
      else if (i.item === 'social') fields.socialLinks = [{ platform: 'Social', url: v }]
    }
    if (Object.keys(fields).length === 0) { setError('Add at least one of the items below.'); return }
    setBusy(true)
    setError(null)
    try {
      await kycApi.resubmit(submissionId, fields)
      setSent(true)
      setValues({})
      onSent()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your changes. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="kyc-changes-heading" className="mb-6 rounded-xl border border-warning/40 bg-surface shadow-card p-5 space-y-4">
      <div className="space-y-1">
        <h2 id="kyc-changes-heading" className="text-base font-bold text-text-primary">A few things need to be sent again</h2>
        <p className="text-sm text-text-secondary">
          {[review.basicState !== 'not_requested' && `Basic KYC: ${STATE_TEXT[review.basicState]}`, review.enhancedState !== 'not_requested' && `Enhanced KYC: ${STATE_TEXT[review.enhancedState]}`].filter(Boolean).join(' · ')}
        </p>
        <p className="text-xs text-text-muted">Everything else you sent was fine and was kept. You only need to replace the items below.</p>
      </div>

      <ul className="space-y-4">
        {flagged.map((i) => (
          <li key={i.item} className="space-y-1.5">
            <p className="text-sm font-semibold text-text-primary">{i.label ?? i.item}</p>
            {i.reason && <p className="text-sm text-danger">{i.reason}</p>}
            {FILE_ITEMS[i.item] ? (
              <FileItem type={FILE_ITEMS[i.item]!.type} onUploaded={(url) => set(i.item, url)} />
            ) : (
              <input
                type={TEXT_HINT[i.item]?.type ?? 'text'} value={values[i.item] ?? ''} maxLength={500}
                aria-label={i.label ?? i.item} placeholder={TEXT_HINT[i.item]?.placeholder}
                onChange={(e) => set(i.item, e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            )}
          </li>
        ))}
      </ul>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {sent && <p role="status" className="text-sm text-success">Sent. We will review it soon.</p>}
      <button
        type="button" onClick={() => void send()} disabled={busy}
        className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send changes'}
      </button>
    </section>
  )
}
