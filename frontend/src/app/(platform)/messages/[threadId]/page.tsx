'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import {
  messagingApi, episodeTradeHref, episodeProgress, OUTCOME_LABEL,
  type ThreadView, type ThreadMessage, type TradeEpisode,
} from '@/lib/messaging'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Button } from '@/components/ui/Button'
import { useFileUpload } from '@/hooks/useFileUpload'
import { isTrustedImageUrl } from '@/lib/utils'
import { fmtTime, fmtPkr } from '@/lib/fmt'
import { ArrowLeft, Send, CheckCircle2, XCircle, AlertTriangle, Clock, ImagePlus, X, Loader2 } from 'lucide-react'

type TimelineItem =
  | { kind: 'message'; at: number; msg: ThreadMessage }
  | { kind: 'episode'; at: number; ep: TradeEpisode }

const OUTCOME_ICON: Record<TradeEpisode['outcome'], React.ElementType> = {
  active: Clock, completed: CheckCircle2, cancelled: XCircle, expired: Clock, disputed: AlertTriangle,
}
const OUTCOME_CLS: Record<TradeEpisode['outcome'], string> = {
  active: 'text-blue-500', completed: 'text-emerald-500', cancelled: 'text-text-muted',
  expired: 'text-text-muted', disputed: 'text-amber-500',
}

export default function MessageThreadPage() {
  const { user } = useAuth()
  const { threadId } = useParams<{ threadId: string }>()
  const [data, setData] = useState<ThreadView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pending image attachment — uploaded to Cloudinary the moment it's picked, then
  // sent with the next message (as an optional-caption attachment).
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const { upload, uploading } = useFileUpload('chat-image')

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

  const load = useCallback(async () => {
    try {
      setData(await messagingApi.getThread(threadId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load conversation')
    }
  }, [threadId])

  useEffect(() => { if (user) void load() }, [user, load])

  // Poll for new messages while the thread is open.
  useEffect(() => {
    if (!user) return
    const id = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(id)
  }, [user, load])

  // Build a single time-ordered timeline of episode dividers + messages.
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!data) return []
    const items: TimelineItem[] = [
      ...data.messages.map((m) => ({ kind: 'message' as const, at: new Date(m.createdAt).getTime(), msg: m })),
      ...data.episodes.map((e) => ({ kind: 'episode' as const, at: new Date(e.startedAt).getTime(), ep: e })),
    ]
    return items.sort((a, b) => a.at - b.at)
  }, [data])

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

  const send = async () => {
    const body = draft.trim()
    // A message needs either text or an image attachment.
    if ((!body && !pendingImage) || sending) return
    setSending(true)
    try {
      await messagingApi.postMessage(threadId, body, pendingImage ?? undefined)
      setDraft('')
      setPendingImage(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send')
    } finally {
      setSending(false)
    }
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

  if (error) return <ErrorState description={error} onRetry={load} />
  if (!data) return <LoadingState />

  const name = data.other.fullName || data.other.username || 'Trader'
  const s = data.stats

  return (
    // Fill the viewport below the navbar. On mobile we cancel the parent <main>'s
    // bottom padding (-mb) and reserve our own (pb) so the composer sits just
    // ABOVE the fixed BottomNav instead of being hidden behind it — the input is
    // visible the instant the thread opens, no scrolling required.
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-4rem)] pb-[calc(4rem+max(1rem,env(safe-area-inset-bottom)))] -mb-[calc(6rem+env(safe-area-inset-bottom))] lg:h-[calc(100dvh-4rem)] lg:pb-0 lg:mb-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
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
      </div>

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
          const hasImage = isTrustedImageUrl(m.attachmentUrl)
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-primary text-white rounded-br-sm' : 'bg-muted text-text-primary rounded-bl-sm'}`}>
                {hasImage && (
                  <a href={m.attachmentUrl!} target="_blank" rel="noopener noreferrer" className="block mb-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.attachmentUrl!} alt="Attachment" className="rounded-lg max-h-64 w-auto max-w-full object-cover" />
                  </a>
                )}
                {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                <p className={`text-[10px] mt-0.5 ${mine ? 'text-white/70' : 'text-text-muted'}`}>{fmtTime(m.createdAt)}</p>
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
            <div className="relative inline-block">
              {uploading ? (
                <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-border bg-muted">
                  <Loader2 className="w-5 h-5 text-text-muted animate-spin" />
                </div>
              ) : (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pendingImage!} alt="Attachment preview" className="h-20 w-20 rounded-lg border border-border object-cover" />
                  <button
                    type="button"
                    onClick={() => setPendingImage(null)}
                    aria-label="Remove image"
                    className="absolute -right-2 -top-2 rounded-full bg-text-primary text-surface p-0.5 shadow"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
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
            disabled={uploading || sending}
            aria-label="Attach image"
            className="p-2 rounded-full text-text-muted hover:text-primary hover:bg-muted transition-colors disabled:opacity-50"
          >
            <ImagePlus className="w-5 h-5" />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder="Type a message…"
            maxLength={2000}
            className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:border-primary"
          />
          <Button size="sm" onClick={() => void send()} disabled={sending || uploading || (!draft.trim() && !pendingImage)} aria-label="Send">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
