'use client'

import { useEffect, useState } from 'react'
import { Copy, Check, RefreshCw, Gift, Timer } from 'lucide-react'
import { shareApi } from '@/lib/api'
import type { ShareInfo } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { ShareImage } from '@/components/gas/ShareImage'

function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/**
 * Share & Earn card shown on a delivered gas order. Gives a ready-made, varied X post,
 * collects the post link, and shows the review / reward state. Renders nothing unless
 * the server says the order is eligible (feature switch + test-account allowlist).
 */
export function ShareRewardCard({ orderRef }: { orderRef: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [variant, setVariant] = useState(0)
  const [copied, setCopied] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let live = true
    shareApi.getInfo(orderRef, variant).then((r) => { if (live) setInfo(r) }).catch(() => { if (live) setInfo(null) })
    return () => { live = false }
  }, [orderRef, variant])

  if (!info?.eligible) return null
  const reward = info.reward
  const msLeft = info.deadlineAt ? new Date(info.deadlineAt).getTime() - now : null
  const expired = !reward && msLeft !== null && msLeft <= 0
  if (expired) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(info?.text ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { toast.error('Could not copy. Select the text manually.') }
  }

  async function submit() {
    setBusy(true)
    try {
      await shareApi.submit(orderRef, url.trim())
      toast.success('Thanks! We will review your post shortly.')
      setUrl('')
      setInfo(await shareApi.getInfo(orderRef, variant))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit the link')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-left space-y-3">
      <div className="flex items-start gap-2.5">
        <Gift className="mt-0.5 h-6 w-6 flex-shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          {!reward ? (
            <>
              <p className="text-base font-black text-text-primary leading-snug">
                You have a chance to get <span className="text-success">{info.rewardPct}% OFF</span> your next gas order
              </p>
              <p className="text-xs text-text-muted mt-1">
                Post about this order on X, then paste the link to your post below. We review it and the discount is yours.
              </p>
            </>
          ) : (
            <p className="text-sm font-bold text-text-primary">Share &amp; Earn</p>
          )}
        </div>
      </div>

      {!reward && msLeft !== null && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-warning"><Timer className="h-4 w-4" aria-hidden /> Offer ends in</span>
          <span className="font-mono text-base font-black tabular-nums text-warning">{fmtCountdown(msLeft)}</span>
        </div>
      )}

      {!reward && (
        <>
          {info.card && <ShareImage card={info.card} variant={variant} />}
          <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-secondary whitespace-pre-wrap break-words">{info.text}</div>
          <div className="flex flex-wrap gap-2">
            <a
              href={info.tweetIntentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-lg bg-black px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
            >
              Post on X
            </a>
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setVariant((v) => v + 1)}>
              <RefreshCw className="h-3.5 w-3.5" /> Another version
            </Button>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-text-secondary" htmlFor="share-url">After posting, paste the link to your post</label>
            <div className="flex gap-2">
              <input
                id="share-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                inputMode="url"
                placeholder="https://x.com/yourname/status/…"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <Button size="sm" loading={busy} disabled={url.trim().length < 10} onClick={submit}>Submit</Button>
            </div>
          </div>
        </>
      )}

      {reward?.status === 'submitted' && <p className="text-xs text-text-secondary">Your post is waiting for review. We will notify you as soon as it is approved.</p>}
      {(reward?.status === 'approved' || reward?.status === 'reserved') && (
        <p className="text-sm font-semibold text-success">You earned {reward.discountPct}% off the platform fee on your next gas order. It applies automatically at checkout.</p>
      )}
      {reward?.status === 'used' && <p className="text-xs text-text-secondary">Your {reward.discountPct}% discount has been used. Thanks for sharing!</p>}
      {reward?.status === 'rejected' && <p className="text-xs text-danger">Post not approved{reward.rejectionReason ? `: ${reward.rejectionReason}` : '.'}</p>}
    </div>
  )
}
