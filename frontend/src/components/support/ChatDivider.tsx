import { fmtDate, fmtTime } from '@/lib/fmt'

type DividerKind = 'day' | 'session' | 'closed'

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
