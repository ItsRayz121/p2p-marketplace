import type { ReactNode } from 'react'
import { ShieldCheck, CheckCircle2, Trophy, Star, Clock, AlertTriangle, Info, type LucideIcon } from 'lucide-react'
import type { TradeNoticeTone } from '@/lib/tradeChat'

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

const NOTICE_STYLE: Record<TradeNoticeTone, { icon: LucideIcon; box: string }> = {
  success:   { icon: CheckCircle2,  box: 'bg-success/10 border-success/25 text-success' },
  milestone: { icon: Trophy,        box: 'bg-warning/10 border-warning/25 text-warning' },
  review:    { icon: Star,          box: 'bg-surface-alt border-border text-text-secondary' },
  warning:   { icon: Clock,         box: 'bg-warning/10 border-warning/25 text-warning' },
  danger:    { icon: AlertTriangle, box: 'bg-danger/10 border-danger/25 text-danger' },
  info:      { icon: Info,          box: 'bg-surface-alt border-border text-text-secondary' },
}

/** A neutral trade/system notice (created, complete, dispute, milestone, review prompt): a compact centered card with a tone icon. */
export function TradeNotice({ time, tone = 'info', children }: { time?: string; tone?: TradeNoticeTone; children: ReactNode }) {
  const { icon: Icon, box } = NOTICE_STYLE[tone]
  return (
    <div className="flex justify-center py-1.5">
      <div className={`max-w-[92%] flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-snug ${box}`}>
        <Icon size={14} className="mt-px flex-shrink-0" aria-hidden />
        <p className="font-medium whitespace-pre-wrap break-words">
          {children}
          {time && <span className="ml-2 font-normal opacity-60">{time}</span>}
        </p>
      </div>
    </div>
  )
}
