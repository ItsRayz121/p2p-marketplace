'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Check, Download, RefreshCw, Gift, Tag, Timer, Link2, ChevronDown, Info, Clock, CheckCircle2, AlertCircle, X as XIcon } from 'lucide-react'
import { shareApi } from '@/lib/api'
import type { ShareInfo } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(' : ')
}

/** The X logo (lucide has none). */
function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

const POLL_MS = 8000
const SECONDARY = 'inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-2 text-[12.5px] font-semibold text-text-primary transition-colors hover:bg-surface-alt active:scale-[0.98] disabled:opacity-50'

/**
 * Share & Earn on a delivered gas order: one compact reward card — offer header, the graphic and a
 * short caption preview, one primary "Post on X" action, three small secondary actions, then the
 * post check. Renders nothing unless the server says the order is eligible.
 */
export function ShareRewardCard({ orderRef }: { orderRef: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [variant, setVariant] = useState(0)
  const [switching, setSwitching] = useState(false)
  const [caption, setCaption] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [copied, setCopied] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [imgReady, setImgReady] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const load = useCallback(async (v: number) => {
    try {
      const r = await shareApi.getInfo(orderRef, v)
      if (!alive.current) return
      setInfo(r)
      setCaption(r.text ?? '')
    } catch {
      // Keep what is on screen: a failed refresh is not an error state.
    } finally {
      if (alive.current) setSwitching(false)
    }
  }, [orderRef])

  useEffect(() => { void load(variant) }, [load, variant])

  // While a post is under review, watch for the automated check to finish. It normally takes seconds, so
  // poll briefly (about 3 minutes) and then stop: a post waiting for a person is shown again on next visit.
  const status = info?.reward?.status
  useEffect(() => {
    if (status !== 'submitted') return
    let polls = 0
    const id = setInterval(() => {
      if (++polls > 22) { clearInterval(id); return }
      void shareApi.getInfo(orderRef, variant).then((r) => { if (alive.current) setInfo((prev) => (prev ? { ...prev, reward: r.reward, eligible: r.eligible } : r)) }).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(id)
  }, [status, orderRef, variant])

  if (!info) return null
  if (!info.eligible) {
    if (info.reward) return <RewardStatus info={info} url="" setUrl={() => {}} busy={false} onSubmit={() => {}} />
    return null
  }

  const reward = info.reward
  const msLeft = info.deadlineAt ? new Date(info.deadlineAt).getTime() - now : null
  const open = !reward || reward.status === 'changes_required'
  if (open && msLeft !== null && msLeft <= 0) {
    return <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-left text-xs text-text-muted">The Share &amp; Earn offer for this order has ended.</p>
  }

  const link = info.link ?? ''
  const handle = info.handle ?? null
  const captionProblems: string[] = []
  if (link && !caption.includes(link)) captionProblems.push('the order link')
  if (!/#ad\b/i.test(caption)) captionProblems.push('#ad')
  if (handle && !caption.toLowerCase().includes(`@${handle.toLowerCase()}`)) captionProblems.push(`@${handle}`)
  const captionOk = captionProblems.length === 0 && caption.trim().length > 0
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`
  const imageSrc = `/s/${encodeURIComponent(orderRef)}/image?v=${variant % 3}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(caption)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { toast.error('Could not copy. Select the text instead.') }
  }

  async function download() {
    try {
      const res = await fetch(imageSrc)
      if (!res.ok) throw new Error('image')
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `rupchain-gas-${orderRef}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 2000)
    } catch { toast.error('Could not download the image') }
  }

  function another() {
    if (switching) return
    setSwitching(true)
    setImgReady(false)
    setVariant((v) => v + 1)
  }

  async function submit() {
    if (busy) return
    setBusy(true)
    try {
      await shareApi.submit(orderRef, url.trim())
      toast.success('Post submitted. We are checking it now.')
      setUrl('')
      await load(variant)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit the link')
    } finally { setBusy(false) }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-4 text-left shadow-sm" aria-label="Share and earn">
      <header className="space-y-1.5">
        <div className="flex items-center gap-2.5">
          <Gift className="h-6 w-6 flex-shrink-0 text-primary" aria-hidden />
          <h3 className="min-w-0 flex-1 whitespace-nowrap text-lg font-black leading-tight text-text-primary">Share &amp; Earn</h3>
          {info.rewardPct ? (
            <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-success/10 px-2 py-1 text-xs font-bold text-success">
              <Tag className="h-3.5 w-3.5" aria-hidden /> {info.rewardPct}% OFF
            </span>
          ) : null}
        </div>
        <p className="text-sm text-text-muted">
          {reward?.status === 'changes_required' ? 'A small change is needed before we can unlock your reward.' : 'Share your gas top-up on X to unlock your next reward.'}
        </p>
      </header>

      {open && msLeft !== null && (
        <div className="flex items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-warning/30 bg-warning/10 px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-warning"><Timer className="h-4 w-4 flex-shrink-0" aria-hidden /> Offer expires in</span>
          <span className="flex-shrink-0 font-mono text-base font-black tabular-nums text-warning" role="timer">{fmtCountdown(msLeft)}</span>
        </div>
      )}

      {open && (
        <>
          <div className="relative overflow-hidden rounded-xl border border-border bg-surface-alt">
            {/* The exact graphic that is downloaded and that X shows for the link. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={imageSrc}
              src={imageSrc}
              alt={info.card ? `${info.card.amount} ${info.card.symbol} gas top-up on ${info.card.chainName}` : 'RupChain gas top-up'}
              width={1200}
              height={675}
              onLoad={() => setImgReady(true)}
              onError={() => setImgReady(true)}
              className={cn('block h-auto w-full transition-opacity', imgReady ? 'opacity-100' : 'opacity-0')}
            />
            {!imgReady && <div className="absolute inset-0 animate-pulse bg-surface-alt" aria-hidden />}
          </div>

          <div className="rounded-xl border border-border p-3">
            <div className="flex items-start gap-2">
              {expanded ? (
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  rows={7}
                  maxLength={600}
                  aria-label="Post text"
                  className="min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface-alt p-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              ) : (
                <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-line break-words text-sm text-text-primary">{caption.split('\n\n')[0]}</p>
              )}
              <button type="button" onClick={() => setExpanded((e) => !e)} className="inline-flex flex-shrink-0 items-center gap-1 text-[13px] font-semibold text-primary" aria-expanded={expanded}>
                {expanded ? 'Collapse' : 'Expand'} <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
              </button>
            </div>
            {!expanded && info.hashtags && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {info.hashtags.map((h) => <span key={h} className="rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">{h}</span>)}
              </div>
            )}
            {!captionOk && (
              <p className="mt-2 text-xs text-danger" role="alert">Keep {captionProblems.join(', ')} in the post. Use Another version to reset it.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <a
              href={captionOk ? intentUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!captionOk}
              onClick={(e) => { if (!captionOk) e.preventDefault() }}
              className={cn('flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-bold text-white transition-colors hover:bg-primary-hover active:scale-[0.99]', !captionOk && 'pointer-events-none opacity-50')}
            >
              <XLogo className="h-5 w-5" /> Post on X
            </a>
            <button type="button" onClick={() => setShowHelp((s) => !s)} className="mx-auto flex items-center gap-1 text-xs font-medium text-primary" aria-expanded={showHelp}>
              How to disclose <Info className="h-3.5 w-3.5" aria-hidden />
            </button>
            {showHelp && (
              <div className="rounded-xl border border-border bg-surface-alt p-3 text-[13px] text-text-secondary">
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="font-bold text-text-primary">Paid partnership disclosure</p>
                  <button type="button" onClick={() => setShowHelp(false)} aria-label="Close" className="text-text-muted"><XIcon className="h-4 w-4" /></button>
                </div>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Tap Post on X.</li>
                  <li>In X, open the disclosure option.</li>
                  <li>Turn on Paid Partnership before posting, where X offers it.</li>
                </ol>
                <p className="mt-2 text-xs text-text-muted">The post already says you get a discount (#ad). Write about your own experience; it does not have to be positive.</p>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={copy} className={SECONDARY} disabled={!caption}>
              {copied ? <Check className="h-4 w-4 flex-shrink-0" aria-hidden /> : <Copy className="h-4 w-4 flex-shrink-0" aria-hidden />}<span className="truncate">{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button type="button" onClick={download} className={SECONDARY} aria-label="Download image" title="Download image">
              <Download className="h-4 w-4 flex-shrink-0" aria-hidden />
            </button>
            <button type="button" onClick={another} disabled={switching} className={SECONDARY}>
              <RefreshCw className={cn('h-4 w-4 flex-shrink-0', switching && 'animate-spin')} aria-hidden /><span className="whitespace-nowrap">Another<span className="sr-only"> version</span></span>
            </button>
          </div>
        </>
      )}

      <RewardStatus info={info} url={url} setUrl={setUrl} busy={busy} onSubmit={submit} />
    </section>
  )
}

/** The verify form while a post is still needed, and a compact status chip afterwards. */
function RewardStatus({ info, url, setUrl, busy, onSubmit }: { info: ShareInfo; url: string; setUrl: (v: string) => void; busy: boolean; onSubmit: () => void }) {
  const r = info.reward
  const showForm = !r || r.status === 'changes_required'

  if (showForm) {
    return (
      <div className="space-y-2 rounded-xl border border-border p-3">
        <div className="flex items-center gap-2"><Link2 className="h-5 w-5 text-text-muted" aria-hidden /><p className="font-bold text-text-primary">Verify your post</p></div>
        {r?.status === 'changes_required' ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-[13px] text-warning" role="status">
            <p className="mb-1 flex items-center gap-1.5 font-bold"><AlertCircle className="h-4 w-4" aria-hidden /> Changes needed</p>
            <ul className="list-disc space-y-0.5 pl-5">{(r.issues.length ? r.issues : ['Please check the post and submit it again.']).map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        ) : (
          <p className="text-sm text-text-muted">Paste your X post link to claim your reward.</p>
        )}
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            aria-label="Link to your X post"
            placeholder="https://x.com/username/status/…"
            className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-alt px-3 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button type="button" onClick={onSubmit} disabled={busy || url.trim().length < 10} className="inline-flex h-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-white transition-colors hover:bg-primary-hover disabled:opacity-50">
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-text-muted"><Info className="h-3.5 w-3.5 flex-shrink-0" aria-hidden /> We check your post and notify you shortly.</p>
      </div>
    )
  }

  if (r.status === 'approved' || r.status === 'reserved') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 p-3" role="status">
        <CheckCircle2 className="mt-0.5 h-6 w-6 flex-shrink-0 text-success" aria-hidden />
        <div>
          <p className="font-bold text-text-primary">Reward unlocked</p>
          <p className="text-sm text-text-secondary">{r.discountPct}% off the platform fee on your next gas order. It applies automatically at checkout.</p>
        </div>
      </div>
    )
  }
  if (r.status === 'used') {
    return <p className="flex items-center gap-2 rounded-xl border border-border bg-surface-alt p-3 text-sm text-text-secondary" role="status"><CheckCircle2 className="h-5 w-5 flex-shrink-0 text-text-muted" aria-hidden /> Your {r.discountPct}% reward was used. Thanks for sharing!</p>
  }
  if (r.status === 'rejected') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-3" role="status">
        <AlertCircle className="mt-0.5 h-6 w-6 flex-shrink-0 text-danger" aria-hidden />
        <div>
          <p className="font-bold text-text-primary">Post not approved</p>
          <p className="text-sm text-text-secondary">{r.rejectionReason ?? 'The post did not meet the requirements.'}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3" role="status">
      <Clock className="mt-0.5 h-6 w-6 flex-shrink-0 text-primary" aria-hidden />
      <div>
        <p className="font-bold text-text-primary">Pending review</p>
        <p className="text-sm text-text-secondary">We are checking your post. We will notify you as soon as it is approved.</p>
      </div>
    </div>
  )
}
