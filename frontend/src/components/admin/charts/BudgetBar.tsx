/** Spent vs committed budget. Committed is not spent: the bar shows how much of the cap has been reserved. */
export function BudgetBar({
  spent,
  budget,
  format = (n: number) => `$${n.toFixed(2)}`,
}: {
  spent: number | null
  budget: number | null
  format?: (n: number) => string
}) {
  if (budget == null || budget <= 0) {
    return <span className="text-xs text-text-muted">{spent != null ? `${format(spent)} spent · no USD cap` : 'Not tracked'}</span>
  }
  const pct = Math.min(100, ((spent ?? 0) / budget) * 100)
  const tone = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-primary'
  return (
    <div className="min-w-[120px]">
      <div className="flex justify-between text-[11px] text-text-muted tabular-nums">
        <span>{format(spent ?? 0)}</span>
        <span>{format(budget)}</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-alt" role="progressbar" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spent ?? 0} aria-label="Budget used">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
