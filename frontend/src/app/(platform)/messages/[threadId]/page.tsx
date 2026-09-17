'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { ApiError } from '@/lib/api'
import {
  messagingApi, episodeTradeHref, episodeProgress, OUTCOME_LABEL,
  type ThreadView, type ThreadMessage, type TradeEpisode, type SharedAdPreview,
} from '@/lib/messaging'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Button } from '@/components/ui/Button'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import { Modal } from '@/components/ui/Modal'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { isTrustedImageUrl } from '@/lib/utils'
import { fmtTime, fmtPkr } from '@/lib/fmt'
import { toast } from '@/lib/toast'
import { buildProfileShareLink, isTelegramMiniApp, openTelegramLink, hapticSelection } from '@/lib/telegram'
import { MessageTicks } from '@/components/chat/MessageTicks'
import { ShareAdPicker } from '@/components/chat/ShareAdPicker'
import { ArrowLeft, Send, CheckCircle2, XCircle, AlertTriangle, Clock, ImagePlus, Tag, ExternalLink, X, Trash2, MoreVertical, ShieldOff, ShieldCheck, Flag, Share2 } from 'lucide-react'

/** A message not yet confirmed by the server — rendered like a real one but with
 *  a pending/failed indicator instead of delivery ticks (which only exist once
 *  the server has assigned the message a real id). */
type DisplayMessage = ThreadMessage & { pending?: boolean; failed?: boolean; tempId?: string }

type TimelineItem =
  | { kind: 'message'; at: number; msg: DisplayMessage }
  | { kind: 'episode'; at: number; ep: TradeEpisode }

/** A one-tap-shared listing rendered inline in a chat bubble — tap it to go
 *  straight to the live listing (USDT ad or CTM listing). */
function SharedAdCard({ ad, mine }: { ad: SharedAdPreview; mine: boolean }) {
  if (ad.deleted) {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs italic ${mine ? 'border-white/30 text-white/70' : 'border-border text-text-muted'}`}>
        This listing is no longer available.
      </div>
    )
  }
  const href = ad.market === 'usdt' ? `/marketplace/listings/${ad.id}` : `/ctm/listings/${ad.id}`
  const isSell = ad.side === 'sell'
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-lg border p-2 transition-colors ${mine ? 'border-white/25 hover:bg-white/10' : 'border-border hover:bg-surface-alt'}`}
    >
      <EntityLogo type="token" slug={ad.symbol ?? '?'} size="sm" logoUrl={ad.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${mine ? 'text-white' : 'text-text-primary'}`}>{ad.name} ({ad.symbol})</p>
        <p className={`text-[11px] ${mine ? 'text-white/70' : 'text-text-muted'}`}>
          {isSell ? 'Selling' : 'Buying'} · PKR {ad.price ? Number(ad.price).toLocaleString() : '—'}
          {ad.status && ad.status !== 'active' ? ' · Inactive' : ''}
        </p>
      </div>
      <ExternalLink className={`w-3.5 h-3.5 flex-shrink-0 ${mine ? 'text-white/70' : 'text-text-muted'}`} />
    </Link>
  )
}

const OUTCOME_ICON: Record<TradeEpisode['outcome'], React.ElementType> = {
  active: Clock, completed: CheckCircle2, cancelled: XCircle, expired: Clock, disputed: AlertTriangle, dispute_resolved: CheckCircle2,
}
const OUTCOME_CLS: Record<TradeEpisode['outcome'], string> = {
  active: 'text-blue-500', completed: 'text-emerald-500', cancelled: 'text-text-muted',
  expired: 'text-text-muted', disputed: 'text-amber-500', dispute_resolved: 'text-emerald-500',
}

export default function MessageThreadPage() {
  const { user } = useAuth()
  const { threadId } = useParams<{ threadId: string }>()
  const [data, setData] = useState<ThreadView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Messages sent locally but not yet confirmed by the server — shown immediately
  // (optimistic) with a "sending…" clock, retried automatically on failure, and
  // left with a tap-to-retry affordance if every retry fails. Fixes the "message
  // sometimes doesn't seem to send" complaint: previously a failed POST just left
  // the draft text sitting in the input with no visible feedback.
  const [pendingMessages, setPendingMessages] = useState<DisplayMessage[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Header "⋮" menu — block/unblock + report the other participant.
  const menuAnchorRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [reportSent, setReportSent] = useState(false)

  // One-tap "share my listing" picker.
  const [shareAdOpen, setShareAdOpen] = useState(false)
  const [sharingAd, setSharingAd] = useState(false)

  async function sendSharedAd(item: { market: 'usdt' | 'ctm'; id: string }) {
    if (sharingAd) return
    setSharingAd(true)
    try {
      await messagingApi.postMessage(threadId, '', undefined, undefined, item)
      setShareAdOpen(false)
      await load()
    } catch (e) {
      toast.error('Could not share listing', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setSharingAd(false)
    }
  }

  async function toggleBlock() {
    if (!data || blockBusy) return
    setBlockBusy(true)
    setMenuOpen(false)
    try {
      if (data.blockedByMe) await messagingApi.unblock(threadId)
      else await messagingApi.block(threadId)
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update block status')
    } finally {
      setBlockBusy(false)
    }
  }

  /** Share a profile link — the OTHER participant's when inside their thread
   *  (so you can forward a trader's profile to someone else), or your own from
   *  the My Notes self-thread. Either way the link carries the CURRENT viewer's
   *  own referral code (buildProfileShareLink's convention: the code always
   *  belongs to whoever is sharing, not whoever is being shared) — same
   *  universal-link pattern as the gas/listing share buttons: Telegram's native
   *  share sheet with the `t.me` startapp deep link inside the Mini App, the
   *  Web Share sheet (falling back to clipboard) everywhere else. */
  async function shareProfile() {
    setMenuOpen(false)
    const isSelfShare = !data || data.other.id === user?.id
    const targetUsername = isSelfShare ? user?.username : data?.other.username
    if (!targetUsername) return
    hapticSelection()
    const { web, telegram } = buildProfileShareLink(targetUsername, user?.referralCode)
    const title = isSelfShare ? 'Chat with me on RupChain' : `Chat with ${targetUsername} on RupChain`
    const text = isSelfShare ? 'Message me on RupChain — tap to start a chat.' : `Message ${targetUsername} on RupChain — tap to start a chat.`

    if (isTelegramMiniApp()) {
      const shareUrl = telegram ?? web
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`)
      return
    }

    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title, text, url: web })
        return
      } catch {
        // user dismissed, or share failed — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(web)
      toast.success('Link copied', isSelfShare ? 'Your chat link is on your clipboard' : `${targetUsername}'s chat link is on your clipboard`)
    } catch {
      toast.info('Share this link', web)
    }
  }

  async function submitReport() {
    if (!reportReason.trim() || reportBusy) return
    setReportBusy(true)
    try {
      await messagingApi.report(threadId, reportReason.trim())
      setReportSent(true)
      setReportReason('')
      setTimeout(() => { setReportOpen(false); setReportSent(false) }, 1500)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to file report')
    } finally {
      setReportBusy(false)
    }
  }

  // Pending image attachment — uploaded to Cloudinary the moment it's picked, then
  // sent with the next message (as an optional-caption attachment).
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const { upload, uploading, progress } = useFileUpload('chat-image')

  // Locally-dismissed rate prompts — once the user taps "Rate", the prompt
  // disappears for good (persisted so it stays gone across reloads/polls), even
  // if they don't actually leave a rating. Keyed by episode id.
  const [dismissedRates, setDismissedRates] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try { return new Set(JSON.parse(localStorage.getItem('rc_rate_prompt_dismissed') || '[]') as string[]) } catch { return new Set() }
  })
  const dismissRate = useCallback((epId: string) => {
    setDismissedRates((prev) => {
      if (prev.has(epId)) return prev
      const next = new Set(prev).add(epId)
      try { localStorage.setItem('rc_rate_prompt_dismissed', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])

  // markRead defaults to true (initial load, explicit refreshes); the background
  // poll passes it based on tab visibility so a message isn't shown as "Read"
  // before anyone actually looked at the screen.
  //
  // Overlapping calls are common (mount, the 15s poll, visibilitychange, and the
  // post-send refresh can all be in flight together) and resolve in whatever
  // order the network gives them back, not the order they were issued. Without
  // a sequence guard a slower, older response can land last and clobber fresher
  // state — a just-arrived message or read tick would flicker away until the
  // next poll, which reads to the user as a dropped connection.
  const loadSeq = useRef(0)
  const load = useCallback(async (markRead = true) => {
    const seq = ++loadSeq.current
    try {
      const result = await messagingApi.getThread(threadId, { markRead })
      if (seq === loadSeq.current) setData(result)
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : 'Failed to load conversation')
    }
  }, [threadId])

  useEffect(() => { if (user) void load() }, [user, load])

  // Mark read the moment the tab actually becomes visible again — covers a poll
  // tick landing while backgrounded (see below) never getting a follow-up read.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(true) }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // Poll for new messages while the thread is open. Only marks read while the
  // tab is actually visible — a backgrounded tab still fetches (so unread counts
  // stay current) but doesn't falsely mark incoming messages as seen.
  useEffect(() => {
    if (!user) return
    const id = setInterval(() => { void load(document.visibilityState === 'visible') }, 15_000)
    return () => clearInterval(id)
  }, [user, load])

  // Build a single time-ordered timeline of episode dividers + messages, with any
  // still-unconfirmed local messages appended at the end.
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!data) return []
    // A pending bubble's own POST can still be in flight when a concurrent poll
    // (or a visibilitychange-triggered load) already fetched the SAME message —
    // the server echoes clientId back, so drop the local placeholder the moment
    // it shows up server-side instead of waiting on the original request to
    // resolve. Without this the message briefly renders twice.
    const confirmedClientIds = new Set(data.messages.map((m) => m.clientId).filter((c): c is string => !!c))
    const stillPending = pendingMessages.filter((m) => !m.tempId || !confirmedClientIds.has(m.tempId))
    const items: TimelineItem[] = [
      ...data.messages.map((m) => ({ kind: 'message' as const, at: new Date(m.createdAt).getTime(), msg: m })),
      ...data.episodes.map((e) => ({ kind: 'episode' as const, at: new Date(e.startedAt).getTime(), ep: e })),
      ...stillPending.map((m) => ({ kind: 'message' as const, at: new Date(m.createdAt).getTime(), msg: m })),
    ]
    return items.sort((a, b) => a.at - b.at)
  }, [data, pendingMessages])

  // The latest still-in-progress trade — pinned just under the header so it's
  // reachable without scrolling; the full history stays in the timeline below.
  const activeEpisode = useMemo<TradeEpisode | null>(() => {
    if (!data) return null
    const actives = data.episodes.filter((e) => e.outcome === 'active')
    if (actives.length === 0) return null
    return actives.reduce((latest, e) =>
      new Date(e.startedAt).getTime() > new Date(latest.startedAt).getTime() ? e : latest)
  }, [data])

  // A just-completed trade still inside its 15-minute rating window — surfaces a
  // "Rate this trade" prompt in the thread (H2) that auto-disappears once the
  // window lapses (the 15s poll re-evaluates this). Links to the trade room where
  // the rating box is now prominent.
  const RATING_WINDOW_MS = 15 * 60 * 1000
  const rateableEpisode = useMemo<TradeEpisode | null>(() => {
    if (!data) return null
    const done = data.episodes
      .filter((e) => e.outcome === 'completed' && !e.ratedByMe && !dismissedRates.has(e.id) && e.endedAt && Date.now() - new Date(e.endedAt).getTime() < RATING_WINDOW_MS)
      .sort((a, b) => new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime())
    return done[0] ?? null
  }, [data, RATING_WINDOW_MS, dismissedRates])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [timeline])

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const SEND_RETRY_DELAYS_MS = [1200, 3000] // two automatic retries before giving up

  // Sends are chained through this queue so an earlier message's attempt (and
  // its retries) always finishes hitting the network before the next one
  // starts — otherwise a message that types first but hits a transient retry
  // can land in the database after one typed later, scrambling order for both
  // sides once confirmed.
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve())

  /** Attempt to actually deliver one pending message, retrying transient failures. */
  const attemptSend = useCallback(async (tempId: string, body: string, attachmentUrl?: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        // tempId doubles as the idempotency key: a retry after a lost response
        // reuses it, so the server returns the original message instead of
        // creating a duplicate.
        await messagingApi.postMessage(threadId, body, attachmentUrl, tempId)
        // The message is confirmed sent at this point — drop the local placeholder
        // and treat the follow-up refresh as unrelated best-effort polish. `load`
        // never throws today (it catches internally), but keeping it outside this
        // try/catch means a future change to that can't misreport an already-
        // successful send as a failure and retry it.
        setPendingMessages((prev) => prev.filter((m) => m.tempId !== tempId))
        void load()
        return
      } catch (err) {
        // A 4xx (blocked, validation, thread not found, …) is never going to
        // succeed on retry — fail it immediately instead of burning two more
        // round trips (and several seconds) before surfacing the same error.
        // Network failures and 5xx (status 0 / >=500) are the transient kind
        // retries are actually for.
        const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500
        if (permanent || attempt >= SEND_RETRY_DELAYS_MS.length) {
          setPendingMessages((prev) => prev.map((m) => (m.tempId === tempId ? { ...m, pending: false, failed: true } : m)))
          return
        }
        await sleep(SEND_RETRY_DELAYS_MS[attempt])
      }
    }
  }, [threadId, load])

  const send = async () => {
    if (!user) return
    const body = draft.trim()
    // A message needs either text or an image attachment.
    if (!body && !pendingImage) return
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const attachmentUrl = pendingImage ?? undefined
    // Show it immediately — the user sees their message land in the timeline
    // right away instead of waiting on the network round-trip.
    setPendingMessages((prev) => [...prev, {
      id: tempId, tempId, senderId: user.id, body, attachmentUrl: attachmentUrl ?? null,
      isSystem: false, createdAt: new Date().toISOString(), pending: true,
    }])
    setDraft('')
    setPendingImage(null)
    sendQueueRef.current = sendQueueRef.current.then(() => attemptSend(tempId, body, attachmentUrl))
  }

  /** Tap a failed bubble to try sending it again. */
  const retryPending = (m: DisplayMessage) => {
    if (!m.tempId || !m.failed) return
    setPendingMessages((prev) => prev.map((p) => (p.tempId === m.tempId ? { ...p, failed: false, pending: true } : p)))
    sendQueueRef.current = sendQueueRef.current.then(() => attemptSend(m.tempId!, m.body, m.attachmentUrl ?? undefined))
  }

  // Pick + upload an image; the returned Cloudinary URL waits in pendingImage
  // until the user hits send (so they can add a caption first).
  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      const url = await upload(file)
      setPendingImage(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image upload failed')
    }
  }

  // Retract your own message (soft delete → tombstone). Only the thread's own
  // free-chat messages are deletable — folded trade-room lines (tm_/cm_) are not.
  const deleteMessage = async (id: string) => {
    if (id.startsWith('tm_') || id.startsWith('cm_')) return
    if (!window.confirm('Delete this message? The other trader will see it was removed.')) return
    setData((prev) => prev && { ...prev, messages: prev.messages.map((m) => (m.id === id ? { ...m, deletedAt: new Date().toISOString(), body: '', attachmentUrl: null } : m)) })
    try {
      await messagingApi.deleteMessage(threadId, id)
      await load()
    } catch {
      await load()
    }
  }

  if (error) return <ErrorState description={error} onRetry={load} />
  if (!data) return <LoadingState />

  // The self-notes thread ("My Notes" — see getOrCreateSelfThread on the backend)
  // has the viewer as its own "other" participant. Block/report don't apply to
  // yourself, so the header menu is suppressed entirely for it below.
  const isSelf = data.other.id === user?.id
  const name = isSelf ? 'My Notes' : data.other.fullName || data.other.username || 'Trader'
  const s = data.stats
  const blocked = data.blockedByMe || data.blockedMe

  return (
    // Fill the viewport below the navbar. On mobile we cancel the parent <main>'s
    // bottom padding (-mb) and reserve our own (pb) so the composer sits just
    // ABOVE the fixed BottomNav instead of being hidden behind it — the input is
    // visible the instant the thread opens, no scrolling required.
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-4rem)] pb-[calc(4rem+max(1rem,env(safe-area-inset-bottom)))] -mb-[calc(6rem+env(safe-area-inset-bottom))] lg:h-[calc(100dvh-4rem)] lg:pb-0 lg:mb-0">
      {/* Header — sticky so the counterparty's name is always visible, even while
          scrolling the thread or when the mobile keyboard reflows the layout. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
        <Link href="/messages" className="p-1 -ml-1 rounded hover:bg-muted" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-muted" />
        </Link>
        <UserAvatar name={name} avatarUrl={data.other.avatarUrl} size="md" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary truncate">{name}</p>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            {s.total > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                🤝 {s.total} trade{s.total === 1 ? '' : 's'} together
              </span>
            )}
            <span className="text-[11px] text-text-muted">
              {s.completed > 0 && <span className="text-emerald-500">{s.completed} completed</span>}
              {s.cancelled > 0 && <span>{s.completed > 0 ? ' · ' : ''}{s.cancelled} cancelled</span>}
              {s.disputed > 0 && <span className="text-amber-500">{(s.completed > 0 || s.cancelled > 0) ? ' · ' : ''}{s.disputed} disputed</span>}
            </span>
          </div>
        </div>
        {/* Block/report don't apply to your own notes, and there's only one
            possible share action there — a single icon button, no dropdown. */}
        {isSelf && (
          <button
            onClick={() => void shareProfile()}
            aria-label="Share my profile"
            title="Share my profile"
            className="p-1.5 -mr-1 rounded hover:bg-muted flex-shrink-0"
          >
            <Share2 className="w-5 h-5 text-text-muted" />
          </button>
        )}
        {!isSelf && (
          <>
            <button
              ref={menuAnchorRef}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Conversation options"
              className="p-1.5 -mr-1 rounded hover:bg-muted flex-shrink-0"
            >
              <MoreVertical className="w-5 h-5 text-text-muted" />
            </button>
            <AnchoredMenu anchorRef={menuAnchorRef} open={menuOpen} onClose={() => setMenuOpen(false)} align="end" width={224}>
              <div className="bg-surface border border-border rounded-lg shadow-card py-1">
                <button
                  onClick={() => void shareProfile()}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt"
                >
                  <Share2 className="w-4 h-4" /> Share {name}&apos;s profile
                </button>
                <button
                  onClick={toggleBlock}
                  disabled={blockBusy}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-surface-alt disabled:opacity-50"
                >
                  {data.blockedByMe ? <ShieldCheck className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                  {data.blockedByMe ? 'Unblock' : 'Block'} {name}
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setReportOpen(true) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-danger hover:bg-surface-alt"
                >
                  <Flag className="w-4 h-4" /> Report {name}
                </button>
              </div>
            </AnchoredMenu>
          </>
        )}
      </div>

      {/* Block state banner */}
      {!isSelf && (data.blockedByMe || data.blockedMe) && (
        <div className="mx-4 mt-3 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-text-muted text-center">
          {data.blockedByMe
            ? <>You've blocked {name}. <button onClick={toggleBlock} disabled={blockBusy} className="text-primary font-medium hover:underline">Unblock</button> to message again.</>
            : `You can't message ${name} right now.`}
        </div>
      )}

      {/* Pinned in-progress trade — the latest active trade sits at the top so it's
          one tap away; the full trade history remains in the timeline below. */}
      {activeEpisode && (() => {
        const prog = episodeProgress(activeEpisode)
        return (
          <Link
            href={episodeTradeHref(activeEpisode)}
            className="mx-4 mt-3 block rounded-xl border border-blue-500/30 bg-blue-500/5 px-3 py-2 hover:border-blue-500/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Clock className="w-4 h-4 text-blue-500 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500 leading-none">In progress{prog ? ` · step ${prog.index}/${prog.total}` : ''}</p>
                <p className="text-sm font-semibold text-text-primary truncate mt-0.5">
                  {activeEpisode.tradeRef}
                  {activeEpisode.fiatAmount && <span className="text-text-muted font-normal"> · {fmtPkr(activeEpisode.fiatAmount)}</span>}
                </p>
              </div>
              <span className="text-xs font-medium text-blue-500 flex-shrink-0">View →</span>
            </div>
            {/* Compact progress bar (H1) — proportion of steps completed. */}
            {prog && (
              <div className="mt-2">
                <div className="h-1.5 rounded-full bg-blue-500/15 overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${Math.round((prog.index / prog.total) * 100)}%` }} />
                </div>
                <p className="text-[10px] text-text-muted mt-1">{prog.label}</p>
              </div>
            )}
          </Link>
        )
      })()}

      {/* Rate-this-trade prompt (H2) — appears for ~15 min after a trade completes,
          then disappears on its own. Opens the trade room where the rating box is. */}
      {rateableEpisode && (
        <Link
          href={episodeTradeHref(rateableEpisode)}
          onClick={() => dismissRate(rateableEpisode.id)}
          className="mx-4 mt-3 flex items-center gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 hover:border-amber-500/60 transition-colors"
        >
          <span className="text-base leading-none">⭐</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary truncate">Rate this trade — optional</p>
            <p className="text-[11px] text-text-muted truncate">{rateableEpisode.tradeRef} completed. Leave feedback before the window closes.</p>
          </div>
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400 flex-shrink-0">Rate →</span>
        </Link>
      )}

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {timeline.map((item) => {
          if (item.kind === 'episode') {
            const ep = item.ep
            const Icon = OUTCOME_ICON[ep.outcome]
            // Full-width card (not a centered pill) so a long ref like
            // "CTM-20260706-0001" never wraps mid-way and the outcome/amount read
            // as a tidy second line instead of scattering across the row.
            // Compact single-line divider: ref truncates on the left, the market
            // chip + outcome + amount stay pinned right so it reads as one tidy row.
            return (
              <Link
                key={`ep-${ep.id}`}
                href={episodeTradeHref(ep)}
                className="flex items-center gap-2 my-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 hover:border-primary/40 transition-colors"
              >
                <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${OUTCOME_CLS[ep.outcome]}`} />
                <span className="font-semibold text-text-primary text-xs truncate min-w-0 flex-1">{ep.tradeRef}</span>
                <span className="uppercase text-[9px] font-semibold text-text-muted bg-surface border border-border rounded px-1.5 py-0.5 flex-shrink-0">{ep.market}</span>
                <span className={`text-[11px] flex-shrink-0 ${OUTCOME_CLS[ep.outcome]}`}>{OUTCOME_LABEL[ep.outcome]}</span>
                {ep.fiatAmount && <span className="text-[11px] text-text-muted flex-shrink-0">· {fmtPkr(ep.fiatAmount)}</span>}
              </Link>
            )
          }
          const m = item.msg
          if (m.isSystem) {
            return (
              <p key={m.id} className="text-center text-[11px] text-text-muted py-1">{m.body}</p>
            )
          }
          const mine = m.senderId === user?.id
          if (m.deletedAt) {
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[75%] rounded-2xl px-3 py-2 text-xs italic text-text-muted bg-muted/60 border border-dashed border-border">
                  🚫 {mine ? 'You deleted this message' : 'This message was deleted'}
                </div>
              </div>
            )
          }
          const hasImage = isTrustedImageUrl(m.attachmentUrl)
          // Own free-chat message (not a folded trade line, not still-local) inside the 15-min window.
          const deletable =
            mine && !m.pending && !m.failed && !m.id.startsWith('tm_') && !m.id.startsWith('cm_') &&
            Date.now() - new Date(m.createdAt).getTime() < 15 * 60 * 1000
          return (
            <div key={m.id} className={`group flex items-center gap-1.5 ${mine ? 'justify-end' : 'justify-start'}`}>
              {deletable && (
                <button
                  onClick={() => deleteMessage(m.id)}
                  aria-label="Delete message"
                  className="order-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1 rounded-full text-text-muted hover:text-danger hover:bg-muted flex-shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <div
                onClick={() => m.failed && retryPending(m)}
                className={`order-2 max-w-[75%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-primary text-white rounded-br-sm' : 'bg-muted text-text-primary rounded-bl-sm'} ${m.pending ? 'opacity-60' : ''} ${m.failed ? 'opacity-80 cursor-pointer ring-1 ring-red-300' : ''}`}
              >
                {hasImage && (
                  <a href={m.attachmentUrl!} target="_blank" rel="noopener noreferrer" className="block mb-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.attachmentUrl!} alt="Attachment" className="rounded-lg max-h-64 w-auto max-w-full object-cover" />
                  </a>
                )}
                {m.sharedAd && <div className="mb-1"><SharedAdCard ad={m.sharedAd} mine={mine} /></div>}
                {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                <div className={`flex items-center gap-1 mt-0.5 ${mine ? 'justify-end' : ''}`}>
                  {m.failed && <span className="text-[10px] text-red-200">Tap to retry ·</span>}
                  <p className={`text-[10px] ${mine ? 'text-white/70' : 'text-text-muted'}`}>{fmtTime(m.createdAt)}</p>
                  {mine && <MessageTicks status={m.status ?? null} pending={m.pending} failed={m.failed} />}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer — always pinned at the bottom of the thread container, which
          already clears the mobile BottomNav via the container's padding. */}
      <div className="border-t border-border bg-surface">
        {/* Pending-image preview — sits above the input until sent. */}
        {(pendingImage || uploading) && (
          <div className="px-3 pt-3">
            {uploading && progress ? (
              <UploadProgress progress={progress} />
            ) : pendingImage ? (
              <div className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pendingImage} alt="Attachment preview" className="h-20 w-20 rounded-lg border border-border object-cover" />
                <button
                  type="button"
                  onClick={() => setPendingImage(null)}
                  aria-label="Remove image"
                  className="absolute -right-2 -top-2 rounded-full bg-text-primary text-surface p-0.5 shadow"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-2 px-3 py-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPickImage}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || blocked}
            aria-label="Attach image"
            className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
          >
            <ImagePlus className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setShareAdOpen(true)}
            disabled={blocked}
            aria-label="Share one of my listings"
            title="Share a listing"
            className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
          >
            <Tag className="w-5 h-5" />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            onFocus={(e) => { const el = e.currentTarget; setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250) }}
            placeholder={blocked ? "You can't message here" : isSelf ? 'Write a note to yourself…' : 'Type a message…'}
            maxLength={2000}
            disabled={blocked}
            className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:border-primary disabled:opacity-50"
          />
          <Button size="sm" onClick={() => void send()} disabled={uploading || blocked || (!draft.trim() && !pendingImage)} aria-label="Send">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ShareAdPicker
        isOpen={shareAdOpen}
        onClose={() => setShareAdOpen(false)}
        onSelect={(item) => void sendSharedAd(item)}
        sharing={sharingAd}
      />

      <Modal isOpen={reportOpen} onClose={() => setReportOpen(false)} title={`Report ${name}`}>
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Tell us what happened. Our team reviews this in your support conversation — {name} is never notified.
          </p>
          <textarea
            value={reportReason}
            onChange={(e) => setReportReason(e.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="What went wrong?"
            className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-3">
            <button onClick={() => setReportOpen(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface-alt">Cancel</button>
            <button
              onClick={() => void submitReport()}
              disabled={!reportReason.trim() || reportBusy}
              className="flex-1 bg-danger text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
            >
              {reportSent ? 'Sent ✓' : reportBusy ? 'Sending…' : 'Submit report'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
