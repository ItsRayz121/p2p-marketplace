import { fmtDate, fmtTime } from '@/lib/fmt'
import { SUPPORT_RATINGS } from '@/lib/supportChat'

type DividerKind = 'day' | 'session' | 'closed'

/**
 * A centered note for an automated system message that isn't a rating — e.g. the
 * prebuilt "how did we do?" survey message posted when a chat is closed. Shown
 * identically in the user widget and the admin inbox.
 */
export function SupportSystemNote({ body, at }: { body: string; at: string }) {
  return (
    <div className="flex justify-center my-2">
      <div className="max-w-[90%] px-3 py-2 rounded-xl bg-canvas border border-border text-center">
        <p className="text-xs text-text-primary whitespace-pre-wrap break-words">{body}</p>
        <span className="block text-[10px] text-text-muted/70 mt-0.5">{fmtTime(at)}</span>
      </div>
    </div>
  )
}

/**
 * A centered chip for a satisfaction rating (sender="system" message). Shown in
 * both the user widget and the admin inbox so support quality is visible inline.
 */
export function SupportRatingChip({ rating, at }: { rating: number | null | undefined; at: string }) {
  const r = SUPPORT_RATINGS.find((x) => x.score === rating)
  return (
    <div className="flex items-center justify-center my-2">
      <span className="px-3 py-1 rounded-full bg-canvas border border-border text-[11px] font-medium text-text-muted">
        {r ? `${r.emoji} Rated “${r.label}”` : 'Rated support'} · {fmtTime(at)}
      </span>
    </div>
  )
}

/**
 * A centered separator between messages that marks a session boundary in the
 * support chat: the date at the top of a day, the time a resumed chat started,
 * or where a chat was closed. Shared by the user widget and the admin inbox.
 */
export function ChatDivider({ kind, at }: { kind: DividerKind; at: string }) {
  if (kind === 'day') {
    return (
      <div className="flex items-center justify-center my-3">
        <span className="px-3 py-0.5 rounded-full bg-canvas border border-border text-[11px] font-semibold text-text-muted">
          {fmtDate(at)}
        </span>
      </div>
    )
  }

  if (kind === 'closed') {
    return (
      <div className="flex items-center gap-2 my-3 text-text-muted/70">
        <span className="flex-1 h-px bg-border" />
        <span className="text-[10px] uppercase tracking-wide">Chat closed · {fmtTime(at)}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    )
  }

  // session
  return (
    <div className="flex items-center justify-center my-2">
      <span className="px-3 py-0.5 rounded-full bg-primary/10 text-[11px] font-medium text-primary">
        New chat · {fmtTime(at)}
      </span>
    </div>
  )
}
