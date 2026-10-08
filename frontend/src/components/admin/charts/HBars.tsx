'use client'

export interface HBarDatum { id: string; label: string; sublabel?: string; value: number | null; note?: string; faded?: boolean }

/**
 * Horizontal comparison bars; handles negative values (drawn left of the zero line) and
 * null ("Not tracked"). Values are always printed, so colour is not the only signal.
 */
export function HBars({
  data,
  format = (n) => n.toLocaleString(),
  onSelect,
  emptyText = 'No data yet',
}: {
  data: HBarDatum[]
  format?: (n: number) => string
  onSelect?: (id: string) => void
  emptyText?: string
}) {
  if (data.length === 0) return <p className="py-6 text-center text-sm text-text-muted">{emptyText}</p>
  const vals = data.map((d) => d.value).filter((v): v is number => v != null)
  const maxAbs = Math.max(0.0001, ...vals.map(Math.abs))
  const hasNeg = vals.some((v) => v < 0)
  return (
    <ul className="space-y-2">
      {data.map((d) => {
        const pct = d.value == null ? 0 : (Math.abs(d.value) / maxAbs) * (hasNeg ? 50 : 100)
        const neg = (d.value ?? 0) < 0
        const row = (
          <>
            <div className="mb-0.5 flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                {d.label}
                {d.sublabel && <span className="ml-1.5 text-xs font-normal text-text-muted">{d.sublabel}</span>}
              </span>
              <span className={`flex-shrink-0 text-sm font-semibold tabular-nums ${d.value == null ? 'text-text-muted' : neg ? 'text-danger' : 'text-text-primary'}`}>
                {d.value == null ? 'Not tracked' : format(d.value)}
              </span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-surface-alt" aria-hidden>
              {hasNeg && <span className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />}
              {d.value != null && (
                <span
                  className={`absolute inset-y-0 rounded-full ${neg ? 'bg-danger' : 'bg-primary'} ${d.faded ? 'opacity-40' : ''}`}
                  style={neg ? { right: '50%', width: `${pct}%` } : { left: hasNeg ? '50%' : 0, width: `${pct}%` }}
                />
              )}
            </div>
            {d.note && <p className="mt-0.5 text-[11px] text-text-muted">{d.note}</p>}
          </>
        )
        return (
          <li key={d.id}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(d.id)} className="block w-full rounded-lg p-1.5 text-left hover:bg-surface-alt/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{row}</button>
            ) : (
              <div className="p-1.5">{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
