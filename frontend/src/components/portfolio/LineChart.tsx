import { useId } from 'react'
import { formatDecimal } from '@/lib/portfolio/format'

export interface ChartSeries {
  name: string
  /** SVG dash pattern, so series differ by more than colour. */
  dash?: string
  marker: 'circle' | 'square'
  /** Tailwind stroke/fill classes, e.g. "stroke-primary fill-primary". */
  className: string
  /** `v` is a decimal string, or null for a gap (unknown: never zero). */
  points: Array<{ t: string; v: string | null }>
}

interface Props {
  title: string
  description: string
  series: ChartSeries[]
  currency: string
  emptyMessage: string
  /** A way to fix what the empty message says is missing. */
  emptyAction?: { label: string; onClick: () => void }
}

const W = 600, H = 220, PAD_L = 76, PAD_R = 14, PAD_T = 14, PAD_B = 30

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Accessible line chart in plain SVG. Missing values break the line (a visible gap): nothing is
 * interpolated or filled. Numbers are converted with Number() ONLY to place pixels; every value
 * shown to the reader is the original decimal string, also available in the data table below.
 */
export function LineChart({ title, description, series, currency, emptyMessage, emptyAction }: Props) {
  const uid = useId()
  const known = series.flatMap((s) => s.points.filter((p) => p.v !== null))
  if (known.length === 0) {
    return (
      <figure className="rounded-xl border border-border bg-surface p-4">
        <figcaption className="text-sm font-semibold text-text-primary">{title}</figcaption>
        <p className="mt-2 text-xs text-text-muted">{emptyMessage}</p>
        {emptyAction && (
          <button type="button" onClick={emptyAction.onClick} className="mt-2 text-xs font-semibold text-primary hover:underline">{emptyAction.label}</button>
        )}
      </figure>
    )
  }

  const times = series.flatMap((s) => s.points.map((p) => Date.parse(p.t)))
  const tMin = Math.min(...times), tMax = Math.max(...times)
  const ys = known.map((p) => Number(p.v))
  let yMin = Math.min(...ys), yMax = Math.max(...ys)
  const flat = yMin === yMax
  if (flat) { yMin -= 1; yMax += 1 }
  const x = (t: number) => PAD_L + (tMax === tMin ? (W - PAD_L - PAD_R) / 2 : ((t - tMin) / (tMax - tMin)) * (W - PAD_L - PAD_R))
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B)

  const minStr = known.reduce((a, b) => (Number(b.v) < Number(a.v) ? b : a)).v!
  const maxStr = known.reduce((a, b) => (Number(b.v) > Number(a.v) ? b : a)).v!

  // Continuous runs only: a null ends the current run.
  const runs = (s: ChartSeries) => {
    const out: Array<Array<{ x: number; y: number }>> = []
    let cur: Array<{ x: number; y: number }> = []
    for (const p of s.points) {
      if (p.v === null) { if (cur.length) out.push(cur); cur = [] } else cur.push({ x: x(Date.parse(p.t)), y: y(Number(p.v)) })
    }
    if (cur.length) out.push(cur)
    return out
  }

  const allTimes = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t)))).sort()
  const valueAt = (s: ChartSeries, t: string) => s.points.find((p) => p.t === t)?.v ?? null

  return (
    <figure className="rounded-xl border border-border bg-surface p-4 space-y-2">
      <figcaption className="text-sm font-semibold text-text-primary">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${uid}-t`} aria-describedby={`${uid}-d`} className="w-full h-auto">
        <title id={`${uid}-t`}>{title}</title>
        <desc id={`${uid}-d`}>{description}</desc>
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} className="stroke-border" strokeWidth={1} />
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} className="stroke-border" strokeWidth={1} />
        {flat ? (
          // Every known value is the same: one label at the line's height instead of the same number twice.
          <text x={PAD_L - 6} y={y(Number(maxStr)) + 3} textAnchor="end" className="fill-text-muted" fontSize={10}>{formatDecimal(maxStr, 0)}</text>
        ) : (
          <>
            <text x={PAD_L - 6} y={PAD_T + 8} textAnchor="end" className="fill-text-muted" fontSize={10}>{formatDecimal(maxStr, 0)}</text>
            <text x={PAD_L - 6} y={H - PAD_B} textAnchor="end" className="fill-text-muted" fontSize={10}>{formatDecimal(minStr, 0)}</text>
          </>
        )}
        <text x={PAD_L} y={H - 8} textAnchor="start" className="fill-text-muted" fontSize={10}>{fmtDate(new Date(tMin).toISOString())}</text>
        <text x={W - PAD_R} y={H - 8} textAnchor="end" className="fill-text-muted" fontSize={10}>{fmtDate(new Date(tMax).toISOString())}</text>
        {series.map((s) => (
          <g key={s.name} className={s.className}>
            {runs(s).map((run, i) =>
              run.length === 1 ? (
                s.marker === 'circle'
                  ? <circle key={i} cx={run[0]!.x} cy={run[0]!.y} r={3.5} stroke="none" />
                  : <rect key={i} x={run[0]!.x - 3.5} y={run[0]!.y - 3.5} width={7} height={7} stroke="none" />
              ) : (
                <polyline key={i} points={run.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />
              ),
            )}
          </g>
        ))}
      </svg>
      <ul className="flex flex-wrap gap-4 text-xs text-text-secondary" aria-label="Legend">
        {series.map((s) => (
          <li key={s.name} className="inline-flex items-center gap-1.5">
            <svg width={26} height={10} aria-hidden="true" className={s.className}>
              <line x1={0} y1={5} x2={26} y2={5} strokeWidth={2} strokeDasharray={s.dash} />
              {s.marker === 'circle' ? <circle cx={13} cy={5} r={3} stroke="none" /> : <rect x={10} y={2} width={6} height={6} stroke="none" />}
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-muted">Gaps mean the value is unknown at that time. Amounts are in {currency}.</p>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-primary">View the data as a table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-left text-text-muted border-b border-border">
                <th scope="col" className="py-1 pr-3 font-medium">Date</th>
                {series.map((s) => <th key={s.name} scope="col" className="py-1 pr-3 font-medium text-right">{s.name}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allTimes.map((t) => (
                <tr key={t}>
                  <th scope="row" className="py-1 pr-3 text-left font-normal whitespace-nowrap">{fmtDate(t)}</th>
                  {series.map((s) => {
                    const v = valueAt(s, t)
                    return <td key={s.name} className="py-1 pr-3 text-right">{v === null ? 'Not known' : formatDecimal(v)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
