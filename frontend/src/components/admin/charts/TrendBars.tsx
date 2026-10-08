'use client'
import { useState } from 'react'

export interface TrendSeries { key: string; label: string; className: string }

/**
 * Daily stacked-bar trend (hand-rolled SVG, no chart library). Colour is never the only
 * cue: every bar has a hover/focus tooltip and the full data is available as a screen-reader table.
 */
export function TrendBars({
  data,
  series,
  height = 160,
  unit = 'redemptions',
}: {
  data: Array<Record<string, number | string>>
  series: TrendSeries[]
  height?: number
  unit?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const w = 640
  const pad = { t: 8, r: 8, b: 22, l: 28 }
  const totals = data.map((d) => series.reduce((s, k) => s + Number(d[k.key] ?? 0), 0))
  const max = Math.max(1, ...totals)
  const innerW = w - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const bw = innerW / Math.max(1, data.length)
  const ticks = [0, Math.ceil(max / 2), max]
  const hasAny = totals.some((t) => t > 0)

  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${w} ${height}`} className="w-full h-auto" role="img" aria-label={`Daily ${unit} over the last ${data.length} days`}>
          {ticks.map((t) => {
            const y = pad.t + innerH - (t / max) * innerH
            return (
              <g key={t}>
                <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} className="stroke-border" strokeWidth={0.5} strokeDasharray={t === 0 ? undefined : '3 3'} />
                <text x={pad.l - 4} y={y + 3} textAnchor="end" className="fill-text-muted" fontSize={9}>{t}</text>
              </g>
            )
          })}
          {data.map((d, i) => {
            let acc = 0
            const x = pad.l + i * bw + bw * 0.15
            return (
              <g
                key={String(d.date)}
                tabIndex={0}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none"
              >
                <rect x={pad.l + i * bw} y={pad.t} width={bw} height={innerH} fill="transparent" />
                {series.map((s) => {
                  const v = Number(d[s.key] ?? 0)
                  if (!v) return null
                  const h = (v / max) * innerH
                  const y = pad.t + innerH - acc - h
                  acc += h
                  return <rect key={s.key} x={x} y={y} width={bw * 0.7} height={h} rx={1.5} className={s.className} />
                })}
                {(i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0) && (
                  <text x={x + bw * 0.35} y={height - 6} textAnchor="middle" className="fill-text-muted" fontSize={9}>{String(d.date).slice(5)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {active != null && (
          <div className="pointer-events-none absolute right-2 top-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-card-md">
            <p className="font-semibold text-text-primary">{String(data[active]!.date)}</p>
            {series.map((s) => (
              <p key={s.key} className="text-text-secondary">{s.label}: <strong className="text-text-primary">{Number(data[active]![s.key] ?? 0)}</strong></p>
            ))}
          </div>
        )}
        {!hasAny && <p className="absolute inset-0 flex items-center justify-center text-xs text-text-muted">No {unit} in this period</p>}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {series.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.className.replace('fill-', 'bg-')}`} aria-hidden />{s.label}
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>Daily {unit}</caption>
        <thead><tr><th>Date</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
        <tbody>{data.map((d) => <tr key={String(d.date)}><td>{String(d.date)}</td>{series.map((s) => <td key={s.key}>{Number(d[s.key] ?? 0)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}
