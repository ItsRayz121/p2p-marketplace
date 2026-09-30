import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'

/**
 * A trade lifecycle event performed by a participant ("Payment proof uploaded…"),
 * shown as a bubble on the actor's side — right when the viewer did it, left when
 * the counterparty did. Shared by the Messages thread and both trade rooms.
 */
export function TradeEventBubble({ mine, senderName, time, children }: {
  mine: boolean
  senderName: string
  time: string
  children: ReactNode
}) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] px-3 py-2 rounded-2xl bg-surface border border-border shadow-sm ${mine ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
        <p className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary mb-1">
          <ShieldCheck size={12} className="flex-shrink-0" aria-hidden />
          {senderName}
        </p>
        <p className="text-sm text-text-primary leading-relaxed break-words whitespace-pre-wrap">{children}</p>
        <p className="text-[10px] text-text-muted/60 mt-0.5">{time}</p>
      </div>
    </div>
  )
}

/** A neutral trade/system notice (created, complete, dispute, milestone, review prompt): centered, one item per event. */
export function TradeNotice({ time, children }: { time?: string; children: ReactNode }) {
  return (
    <div className="flex justify-center py-1">
      <p className="max-w-[90%] text-center text-[11px] leading-snug text-text-muted whitespace-pre-wrap break-words">
        {children}
        {time && <span className="ml-1.5 text-text-muted/60">· {time}</span>}
      </p>
    </div>
  )
}
