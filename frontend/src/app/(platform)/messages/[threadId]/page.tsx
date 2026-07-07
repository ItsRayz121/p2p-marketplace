'use client'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import {
  messagingApi, episodeTradeHref, OUTCOME_LABEL,
  type ThreadView, type ThreadMessage, type TradeEpisode,
} from '@/lib/messaging'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Button } from '@/components/ui/Button'
import { fmtTime, fmtPkr } from '@/lib/fmt'
import { ArrowLeft, Send, CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react'

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [timeline])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    try {
      await messagingApi.postMessage(threadId, body)
      setDraft('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send')
    } finally {
      setSending(false)
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
    <div className="max-w-2xl mx-auto flex flex-col h-[calc(100dvh-4rem)] pb-[calc(4rem+env(safe-area-inset-bottom))] -mb-[calc(6rem+env(safe-area-inset-bottom))] lg:h-[calc(100dvh-4rem)] lg:pb-0 lg:mb-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface">
        <Link href="/messages" className="p-1 -ml-1 rounded hover:bg-muted" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-muted" />
        </Link>
        <UserAvatar name={name} avatarUrl={data.other.avatarUrl} size="md" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary truncate">{name}</p>
          <p className="text-xs text-text-muted">
            {s.total} trade{s.total === 1 ? '' : 's'} together
            {s.completed > 0 && <span className="text-emerald-500"> · {s.completed} completed</span>}
            {s.cancelled > 0 && <span> · {s.cancelled} cancelled</span>}
            {s.disputed > 0 && <span className="text-amber-500"> · {s.disputed} disputed</span>}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {timeline.map((item) => {
          if (item.kind === 'episode') {
            const ep = item.ep
            const Icon = OUTCOME_ICON[ep.outcome]
            return (
              <div key={`ep-${ep.id}`} className="flex items-center gap-2 my-3">
                <div className="flex-1 h-px bg-border" />
                <Link
                  href={episodeTradeHref(ep)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-border text-xs hover:border-primary/40"
                >
                  <Icon className={`w-3.5 h-3.5 ${OUTCOME_CLS[ep.outcome]}`} />
                  <span className="font-medium text-text-primary">{ep.tradeRef}</span>
                  <span className="text-text-muted">· {OUTCOME_LABEL[ep.outcome]}</span>
                  {ep.fiatAmount && <span className="text-text-muted">· {fmtPkr(ep.fiatAmount)}</span>}
                  <span className="uppercase text-[9px] text-text-muted">{ep.market}</span>
                </Link>
                <div className="flex-1 h-px bg-border" />
              </div>
            )
          }
          const m = item.msg
          if (m.isSystem) {
            return (
              <p key={m.id} className="text-center text-[11px] text-text-muted py-1">{m.body}</p>
            )
          }
          const mine = m.senderId === user?.id
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-primary text-white rounded-br-sm' : 'bg-muted text-text-primary rounded-bl-sm'}`}>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className={`text-[10px] mt-0.5 ${mine ? 'text-white/70' : 'text-text-muted'}`}>{fmtTime(m.createdAt)}</p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Composer — always pinned at the bottom of the thread container, which
          already clears the mobile BottomNav via the container's padding. */}
      <div className="flex items-center gap-2 px-3 py-3 border-t border-border bg-surface">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder="Type a message…"
          maxLength={2000}
          className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm focus:outline-none focus:border-primary"
        />
        <Button size="sm" onClick={() => void send()} disabled={sending || !draft.trim()} aria-label="Send">
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}
