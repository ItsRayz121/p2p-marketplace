'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Send, Clock, Paperclip, X } from 'lucide-react'
import { platformTaskApi, PAYOUT_NETWORKS, type UserPlatformTask, type ClaimStatus, type ProofAttachment } from '@/lib/platformTasks'
import { useFileUpload } from '@/hooks/useFileUpload'
import { toast } from '@/lib/toast'
import { isTrustedImageUrl } from '@/lib/utils'

const CLAIM_BADGE: Record<ClaimStatus, { text: string; cls: string }> = {
  pending_review: { text: 'In review', cls: 'text-warning bg-warning/10' },
  needs_changes: { text: 'Changes needed', cls: 'text-info bg-info/10' },
  awaiting_payout: { text: 'Approved · payout pending', cls: 'text-warning bg-warning/10' },
  completed: { text: 'Completed', cls: 'text-success bg-success/10' },
  rejected: { text: 'Not approved', cls: 'text-danger bg-danger/10' },
}

const METHOD: Record<UserPlatformTask['verifyMode'], { label: string; hint: string }> = {
  telegram_auto: { label: 'Verified automatically', hint: 'We check your linked Telegram account is a member. Opening the link alone does not count.' },
  manual_proof: { label: 'Manual review', hint: 'Submit your proof; our team reviews it before the reward is released.' },
  self_claim: { label: 'Self-confirmed', hint: 'Only claim after you have actually done the task — opening the link does not verify it.' },
}

function rewardLabel(t: UserPlatformTask): string {
  return t.rewardType === 'points' ? `${t.rewardPoints} points` : `$${(t.rewardUsdt ?? 0).toFixed(2)} USDT`
}

const MAX_FILES = 4
const fieldCls = 'w-full rounded-lg border border-border bg-canvas px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary'

/** Proof entry shared by the first submission and by resubmitting after "changes needed". */
function EvidenceFields({ task, proof, setProof, links, setLinks, files, setFiles }: {
  task: UserPlatformTask
  proof: string; setProof: (v: string) => void
  links: string; setLinks: (v: string) => void
  files: ProofAttachment[]; setFiles: (f: ProofAttachment[]) => void
}) {
  const { upload, uploading, progress } = useFileUpload('task-proof')
  const input = useRef<HTMLInputElement>(null)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? [])
    e.target.value = ''
    for (const file of list) {
      if (files.length >= MAX_FILES) { toast.error(`You can attach up to ${MAX_FILES} files.`); break }
      try {
        const url = await upload(file)
        setFiles([...files, { url, name: file.name, size: file.size, mime: file.type }])
        files = [...files, { url, name: file.name, size: file.size, mime: file.type }]
      } catch (err) { toast.error(err instanceof Error ? err.message : 'Upload failed') }
    }
  }

  return (
    <div className="space-y-2">
      {task.proofRequirements && <p className="rounded-lg bg-surface-alt px-3 py-2 text-xs text-text-secondary"><span className="font-semibold text-text-primary">Proof needed: </span>{task.proofRequirements}</p>}
      <textarea value={proof} onChange={(e) => setProof(e.target.value)} maxLength={500} rows={2} placeholder="Your username or a short note" className={fieldCls} />
      <textarea value={links} onChange={(e) => setLinks(e.target.value)} rows={2} placeholder={'Links to your proof (https://…), one per line'} className={fieldCls} />
      <div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={pick} />
        <button type="button" onClick={() => input.current?.click()} disabled={uploading || files.length >= MAX_FILES}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-surface-alt disabled:opacity-50">
          <Paperclip className="h-3.5 w-3.5" aria-hidden />{uploading ? `Uploading ${progress?.pct ?? 0}%…` : task.proofFileRequired ? 'Attach a screenshot (required)' : 'Attach a screenshot'}
        </button>
        <span className="ml-2 text-[11px] text-text-muted">JPG, PNG or WebP · up to 10 MB each</span>
        {files.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f.url} className="inline-flex items-center gap-1 rounded-full bg-surface-alt px-2.5 py-1 text-[11px] text-text-primary">
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.url !== f.url))}><X className="h-3 w-3 text-text-muted" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const splitLinks = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean)

export function PlatformTaskCard({
  task,
  telegramLinked,
  kycOk,
  onDone,
}: {
  task: UserPlatformTask
  telegramLinked: boolean
  kycOk: boolean
  onDone: () => void
}) {
  const [proof, setProof] = useState('')
  const [links, setLinks] = useState('')
  const [files, setFiles] = useState<ProofAttachment[]>([])
  const [network, setNetwork] = useState<(typeof PAYOUT_NETWORKS)[number]>('BEP20')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)

  const needsAddress = task.rewardType === 'usdt' && task.payoutMode === 'manual'
  const needsProof = task.verifyMode === 'manual_proof'
  const blockedKyc = task.requireKyc && !kycOk
  const blockedTelegram = task.verifyMode === 'telegram_auto' && !telegramLinked
  const hasEvidence = proof.trim().length > 0 || splitLinks(links).length > 0 || files.length > 0
  const evidenceOk = !needsProof || (hasEvidence && (!task.proofFileRequired || files.length > 0))
  const resubmitting = !!task.claim?.canResubmit

  async function submit() {
    setBusy(true)
    try {
      const evidence = needsProof ? { proof, links: splitLinks(links), attachments: files } : {}
      if (resubmitting) {
        await platformTaskApi.resubmit(task.id, evidence)
        toast.success('Resubmitted! We will take another look.')
      } else {
        const res = await platformTaskApi.claim(task.id, {
          ...evidence,
          ...(needsAddress ? { payoutNetwork: network, payoutAddress: address } : {}),
        })
        toast.success(res.status === 'pending_review' ? 'Submitted! We will review it soon.' : res.status === 'awaiting_payout' ? 'Verified! Your USDT payout is being prepared.' : 'Done! Reward added.')
      }
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not complete this task')
    } finally {
      setBusy(false)
    }
  }

  const badge = task.claim ? CLAIM_BADGE[task.claim.status] : null
  const submitLabel = resubmitting ? 'Resubmit' : task.verifyMode === 'telegram_auto' ? 'Verify' : needsProof ? 'Submit' : 'Claim reward'

  return (
    <div className="rounded-xl border border-border p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        {isTrustedImageUrl(task.logoUrl ?? null) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={task.logoUrl!} alt="" loading="lazy" decoding="async" className="h-10 w-10 flex-shrink-0 rounded-lg border border-border object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{task.title}</p>
          <p className="text-xs text-emerald-500 font-medium mt-0.5">Reward: {rewardLabel(task)}</p>
        </div>
        {badge && <span className={`flex-shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${badge.cls}`}>{badge.text}</span>}
      </div>
      {task.description && <p className="text-xs text-text-muted">{task.description}</p>}
      {task.instructions && !task.claim?.completedAt && <p className="whitespace-pre-wrap rounded-lg bg-surface-alt px-3 py-2 text-xs text-text-secondary">{task.instructions}</p>}

      <p className="text-[11px] text-text-muted">
        <span className="mr-1.5 rounded-full bg-surface-alt px-2 py-0.5 font-semibold text-text-secondary">{METHOD[task.verifyMode].label}</span>
        <span className="mr-1.5 rounded-full bg-surface-alt px-2 py-0.5 font-semibold text-text-secondary">One-time</span>
        {METHOD[task.verifyMode].hint}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {task.endsAt && !task.claim && (
          <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" aria-hidden />Ends {new Date(task.endsAt).toLocaleDateString()}</span>
        )}
        {task.spotsLeft != null && !task.claim && <span>{task.spotsLeft} spot{task.spotsLeft === 1 ? '' : 's'} left</span>}
        {task.url && (
          <a href={task.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
            <ExternalLink className="w-3 h-3" aria-hidden />Open link
          </a>
        )}
      </div>

      {task.claim?.status === 'needs_changes' && task.claim.feedback && (
        <p className="rounded-lg bg-info/10 px-3 py-2 text-xs text-text-primary"><span className="font-semibold text-info">Changes needed: </span>{task.claim.feedback}</p>
      )}
      {task.claim?.status === 'pending_review' && <p className="text-xs text-text-muted">Your submission is waiting for review. You will be notified when it is decided.</p>}
      {task.claim?.status === 'rejected' && (task.claim.rejectionReason ?? task.claim.feedback) && (
        <p className="text-xs text-danger">Reason: {task.claim.rejectionReason ?? task.claim.feedback}</p>
      )}
      {task.claim?.status === 'completed' && task.claim.txHash && (
        <p className="text-[11px] text-text-muted break-all">Tx: {task.claim.txHash}</p>
      )}
      {task.claim?.status === 'awaiting_payout' && (
        <p className="text-xs text-text-muted">
          {task.claim.payoutStage === 'sending' ? 'Approved. Your USDT is being sent now; we will notify you with the transaction.'
            : task.claim.payoutStage === 'delayed' ? 'Approved. Sending hit a problem and will be retried. Your reward is still reserved.'
            : 'Approved. Your USDT will be sent to your address; we will notify you with the transaction.'}
        </p>
      )}

      {(!task.claim || resubmitting) && (
        <div className="space-y-2 pt-1">
          {blockedKyc && <p className="text-xs text-warning">Identity verification (KYC) is required for this task.</p>}
          {blockedTelegram && (
            <p className="text-xs text-warning">
              Link your Telegram account first in <Link href="/settings" className="underline font-semibold">Settings</Link>.
            </p>
          )}
          {needsProof && <EvidenceFields task={task} proof={proof} setProof={setProof} links={links} setLinks={setLinks} files={files} setFiles={setFiles} />}
          {needsAddress && !resubmitting && (
            <div className="flex gap-2">
              <select
                value={network}
                onChange={(e) => setNetwork(e.target.value as (typeof PAYOUT_NETWORKS)[number])}
                className="rounded-lg border border-border bg-canvas px-2 py-2 text-xs text-text-primary"
                aria-label="USDT network"
              >
                {PAYOUT_NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={100}
                placeholder="Your USDT address"
                className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
          <button
            onClick={submit}
            disabled={busy || blockedKyc || blockedTelegram || !evidenceOk || (needsAddress && !resubmitting && !address.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" aria-hidden />
            {busy ? 'Please wait…' : submitLabel}
          </button>
        </div>
      )}
    </div>
  )
}
