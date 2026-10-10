'use client'
import type { Summary } from '@/lib/platformTasks'
import { cn } from '@/lib/utils'

function Card({ label, value, sub, tone, onClick, scope }: { label: string; value: string; sub?: string; tone?: string; onClick: () => void; scope: string }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl border border-border bg-surface p-4 text-left shadow-card transition-colors hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-primary/40">
      <p className="text-xs font-semibold text-text-secondary">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums text-text-primary', tone)}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
      <p className="mt-1.5 text-[11px] text-text-muted">{scope}</p>
    </button>
  )
}

/** Four actionable numbers. Points and USDT are never combined. */
export function SummaryRow({ s, rangeLabel, go }: { s: Summary | null; rangeLabel: string; go: (tab: string, extra?: Record<string, string>) => void }) {
  if (!s) {
    return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-[112px] animate-pulse rounded-xl border border-border bg-surface" />)}</div>
  }
  const over = s.pendingReview.overTarget
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card label="Pending review" value={s.pendingReview.count.toLocaleString()} tone={over > 0 ? 'text-warning' : undefined}
        sub={over > 0 ? `${over} waiting longer than ${s.reviewTargetHours}h` : `All within the ${s.reviewTargetHours}h target`}
        scope="Right now" onClick={() => go('review', { status: 'pending_review' })} />
      <Card label="Active tasks" value={s.activeTasks.toLocaleString()} sub="Open for new participation" scope="Right now" onClick={() => go('tasks', { life: 'active' })} />
      <Card label="USDT awaiting payment" value={`$${s.usdtAwaitingPayment.amount.toFixed(2)}`}
        sub={`${s.usdtAwaitingPayment.count} approved ${s.usdtAwaitingPayment.count === 1 ? 'claim' : 'claims'} unpaid`}
        scope="Right now · unpaid balance" onClick={() => go('rewards', { state: 'awaiting_payment' })} />
      <Card label="Points credited" value={s.pointsCredited.amount.toLocaleString()}
        sub={`${s.pointsCredited.count} ${s.pointsCredited.count === 1 ? 'reward' : 'rewards'}`}
        scope={`Last ${rangeLabel}`} onClick={() => go('rewards', { type: 'points', state: 'credited' })} />
    </div>
  )
}
