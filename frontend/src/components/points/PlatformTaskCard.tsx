'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Send, Clock } from 'lucide-react'
import { platformTaskApi, PAYOUT_NETWORKS, type UserPlatformTask, type ClaimStatus } from '@/lib/platformTasks'
import { toast } from '@/lib/toast'

const CLAIM_BADGE: Record<ClaimStatus, { text: string; cls: string }> = {
  pending_review: { text: 'In review', cls: 'text-warning bg-warning/10' },
  awaiting_payout: { text: 'Approved · payout pending', cls: 'text-warning bg-warning/10' },
  completed: { text: 'Completed', cls: 'text-success bg-success/10' },
  rejected: { text: 'Not approved', cls: 'text-danger bg-danger/10' },
}

const METHOD: Record<UserPlatformTask['verifyMode'], { label: string; hint: string }> = {
  telegram_auto: { label: 'Verified automatically', hint: 'We check your linked Telegram account is a member. Opening the link alone does not count.' },
  manual_proof: { label: 'Manual review', hint: 'Submit your username or a proof link; our team reviews it before the reward is released.' },
  self_claim: { label: 'Self-confirmed', hint: 'Only claim after you have actually done the task — opening the link does not verify it.' },
}

function rewardLabel(t: UserPlatformTask): string {
  return t.rewardType === 'points' ? `${t.rewardPoints} points` : `$${(t.rewardUsdt ?? 0).toFixed(2)} USDT`
}

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
  const [network, setNetwork] = useState<(typeof PAYOUT_NETWORKS)[number]>('BEP20')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)

  const needsAddress = task.rewardType === 'usdt' && task.payoutMode === 'manual'
  const needsProof = task.verifyMode === 'manual_proof'
  const blockedKyc = task.requireKyc && !kycOk
  const blockedTelegram = task.verifyMode === 'telegram_auto' && !telegramLinked

  async function submit() {
    setBusy(true)
    try {
      const res = await platformTaskApi.claim(task.id, {
        ...(needsProof ? { proof } : {}),
        ...(needsAddress ? { payoutNetwork: network, payoutAddress: address } : {}),
      })
      toast.success(res.status === 'pending_review' ? 'Submitted! We will review it soon.' : res.status === 'awaiting_payout' ? 'Verified! Your USDT payout is being prepared.' : 'Done! Reward added.')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not complete this task')
    } finally {
      setBusy(false)
    }
  }

  const badge = task.claim ? CLAIM_BADGE[task.claim.status] : null
  const submitLabel = task.verifyMode === 'telegram_auto' ? 'Verify' : needsProof ? 'Submit' : 'Claim reward'

  return (
    <div className="rounded-xl border border-border p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{task.title}</p>
          <p className="text-xs text-emerald-500 font-medium mt-0.5">Reward: {rewardLabel(task)}</p>
        </div>
        {badge && <span className={`flex-shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${badge.cls}`}>{badge.text}</span>}
      </div>
      {task.description && <p className="text-xs text-text-muted">{task.description}</p>}

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

      {task.claim?.status === 'rejected' && task.claim.rejectionReason && (
        <p className="text-xs text-danger">Reason: {task.claim.rejectionReason}</p>
      )}
      {task.claim?.status === 'completed' && task.claim.txHash && (
        <p className="text-[11px] text-text-muted break-all">Tx: {task.claim.txHash}</p>
      )}

      {!task.claim && (
        <div className="space-y-2 pt-1">
          {blockedKyc && <p className="text-xs text-warning">Identity verification (KYC) is required for this task.</p>}
          {blockedTelegram && (
            <p className="text-xs text-warning">
              Link your Telegram account first in <Link href="/settings" className="underline font-semibold">Settings</Link>.
            </p>
          )}
          {needsProof && (
            <input
              value={proof}
              onChange={(e) => setProof(e.target.value)}
              maxLength={500}
              placeholder="Your username, link or short proof"
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          )}
          {needsAddress && (
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
            disabled={busy || blockedKyc || blockedTelegram || (needsProof && proof.trim().length < 3) || (needsAddress && !address.trim())}
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
