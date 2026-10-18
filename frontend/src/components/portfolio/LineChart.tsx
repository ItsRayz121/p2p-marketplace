import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
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
  /** Shown under the chart when exactly one value is known (for example "Tracking started today"). */
  singleNote?: string
}

const MAX_W = 640, MIN_W = 280, PAD_R = 16, PAD_T = 22, PAD_B = 30
const DAY = 86_400_000

const FULL_DATE = { day: 'numeric', month: 'short', year: 'numeric' } as const
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, FULL_DATE)
const fmtDateTime = (ms: number) => `${fmtDate(ms)}, ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`

/** A round step (1, 2, 2.5, 5 x 10^n) so the axis reads as 22.5k, 23k, 23.5k instead of 22,830. */
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow
}

/** Axis range with breathing room and round tick values. Numbers are used ONLY to place pixels and labels. */
function yScale(min: number, max: number, wanted: number): { lo: number; hi: number; ticks: number[]; step: number } {
  let a = min, b = max
  if (a === b) { const pad = Math.max(Math.abs(a) * 0.05, 1); a -= pad; b += pad }
  else { const pad = (b - a) * 0.12; a -= pad; b += pad }
  if (min >= 0 && a < 0) a = 0 // a value that cannot be negative should not get a negative axis
  const step = niceStep((b - a) / Math.max(1, wanted - 1))
  const lo = Math.floor(a / step) * step
  const hi = Math.ceil(b / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step)
  return { lo, hi, ticks, step }
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
function tickLabel(n: number, step: number): string {
  if (Math.abs(n) >= 10_000) return compact.format(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: step < 1 ? 2 : step < 10 ? 1 : 0 })
}

function xTickLabel(ms: number, spanMs: number): string {
  if (spanMs <= 2 * DAY) return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const d = new Date(ms)
  return spanMs > 300 * DAY ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Accessible line chart in plain SVG. Missing values break the line (a visible gap): nothing is interpolated or
 * filled. Numbers are converted with Number() ONLY to place pixels; every value shown to the reader is the
 * original decimal string. Hover, touch or the arrow keys read exact values; the same facts are available as text
 * for screen readers.
 */
export function LineChart({ title, description, series, currency, emptyMessage, emptyAction, singleNote }: Props) {
  const known = useMemo(() => series.flatMap((s) => s.points.filter((p) => p.v !== null)), [series])
  const empty = known.length === 0
  const uid = useId()
  const figRef = useRef<HTMLElement | null>(null)
  const [W, setW] = useState(MAX_W)
  const [active, setActive] = useState<number | null>(null)

  // Draw at the real pixel width so axis labels stay readable on a phone instead of shrinking with the picture.
  useEffect(() => {
    const el = figRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setW(Math.max(MIN_W, Math.min(MAX_W, Math.round(el.clientWidth - 32))))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [empty])

  const allTimes = useMemo(() => Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.t)))).sort((a, b) => Date.parse(a) - Date.parse(b)), [series])
  const valueAt = useCallback((s: ChartSeries, t: string) => s.points.find((p) => p.t === t)?.v ?? null, [])

  const move = useCallback((dir: -1 | 1 | 'first' | 'last') => {
    setActive((cur) => {
      const last = allTimes.length - 1
      if (dir === 'first') return 0
      if (dir === 'last') return last
      return Math.max(0, Math.min(last, (cur ?? last) + dir))
    })
  }, [allTimes.length])

  if (empty) {
    return (
      <figure className="rounded-2xl border border-border bg-surface p-4 shadow-card">
        <figcaption className="text-sm font-semibold text-text-primary">{title}</figcaption>
        <p className="mt-2 text-xs text-text-muted">{emptyMessage}</p>
        {emptyAction && (
          <button type="button" onClick={emptyAction.onClick} className="mt-2 text-xs font-semibold text-primary hover:underline">{emptyAction.label}</button>
        )}
      </figure>
    )
  }

  const H = W < 420 ? 200 : 240
  const times = allTimes.map((t) => Date.parse(t))
  const tMin = Math.min(...times), tMax = Math.max(...times)
  const ys = known.map((p) => Number(p.v))
  const sc = yScale(Math.min(...ys), Math.max(...ys), W < 420 ? 4 : 5)
  const labels = sc.ticks.map((v) => tickLabel(v, sc.step))
  const PAD_L = Math.min(76, Math.max(40, Math.max(...labels.map((l) => l.length)) * 6.4 + 14))
  const x = (t: number) => PAD_L + (tMax === tMin ? (W - PAD_L - PAD_R) / 2 : ((t - tMin) / (tMax - tMin)) * (W - PAD_L - PAD_R))
  const y = (v: number) => PAD_T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - PAD_T - PAD_B)

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

  const span = tMax - tMin
  const xTickCount = tMax === tMin ? 1 : W < 420 ? 3 : 5
  const xTicks = Array.from({ length: xTickCount }, (_, i) => (xTickCount === 1 ? tMin : tMin + (span * i) / (xTickCount - 1)))
  const baseY = H - PAD_B

  const single = known.length === 1
  const first = series[0]!
  const latest = [...first.points].reverse().find((p) => p.v !== null)

  const nearest = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * W
    let best = 0, bestD = Infinity
    times.forEach((t, i) => { const d = Math.abs(x(t) - px); if (d < bestD) { bestD = d; best = i } })
    return best
  }
  const onPointer = (e: PointerEvent<SVGSVGElement>) => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const k = e.key
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
      e.preventDefault()
      move(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'Home' ? 'first' : 'last')
    } else if (k === 'Escape') setActive(null)
  }

  const money = (v: string) => `${currency} ${formatDecimal(v)}`
  const activeTime = active !== null ? allTimes[active] : undefined
  const activeX = activeTime ? x(Date.parse(activeTime)) : 0
  const tipLeft = activeTime ? Math.min(Math.max(activeX / W, 0.18), 0.82) * 100 : 0

  // The same facts as text, for screen readers.
  const summaryText = series.map((s) => {
    const vals = s.points.filter((p) => p.v !== null)
    if (vals.length === 0) return `${s.name}: no known values.`
    const nums = vals.map((p) => Number(p.v))
    const lo = vals[nums.indexOf(Math.min(...nums))]!, hi = vals[nums.indexOf(Math.max(...nums))]!
    const lastV = vals[vals.length - 1]!
    const unknown = s.points.length - vals.length
    return `${s.name}: ${vals.length} known value${vals.length === 1 ? '' : 's'}, latest ${money(lastV.v!)} on ${fmtDate(Date.parse(lastV.t))}, lowest ${money(lo.v!)}, highest ${money(hi.v!)}${unknown ? `, ${unknown} date${unknown === 1 ? '' : 's'} with an unknown value` : ''}.`
  }).join(' ')

  return (
    <figure ref={figRef} className="rounded-2xl border border-border bg-surface p-4 shadow-card space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        {latest?.v && <span className="text-xs text-text-muted tabular-nums">Latest <span className="font-semibold text-text-primary">{money(latest.v)}</span></span>}
      </figcaption>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${uid}-t`} aria-describedby={`${uid}-d`} tabIndex={0}
          className="w-full h-auto touch-pan-y select-none rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onPointerMove={onPointer} onPointerDown={onPointer}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null) }}
          onKeyDown={onKey} onFocus={() => setActive((a) => a ?? allTimes.length - 1)} onBlur={() => setActive(null)}
        >
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{`${description} ${summaryText} Use the left and right arrow keys to read each value.`}</desc>
          <defs>
            <linearGradient id={`${uid}-g`} x1="0" y1="0" x2="0" y2="1" className="text-primary">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* grid + y axis labels */}
          {sc.ticks.map((v, i) => (
            <g key={v}>
              <line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} className="stroke-border" strokeWidth={1} strokeDasharray={i === 0 ? undefined : '3 4'} opacity={i === 0 ? 1 : 0.7} />
              <text x={PAD_L - 8} y={y(v) + 3.5} textAnchor="end" className="fill-text-muted" fontSize={10.5}>{labels[i]}</text>
            </g>
          ))}
          <text x={PAD_L - 8} y={10} textAnchor="end" className="fill-text-muted" fontSize={10} fontWeight={600}>{currency}</text>

          {/* x axis labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 9} textAnchor={xTickCount === 1 ? 'middle' : i === 0 ? 'start' : i === xTickCount - 1 ? 'end' : 'middle'} className="fill-text-muted" fontSize={10.5}>
              {xTickLabel(t, span)}
            </text>
          ))}

          {/* soft area under the first series, only where a real line exists */}
          {runs(first).filter((r) => r.length > 1).map((run, i) => (
            <path key={`a${i}`} d={`M${run[0]!.x},${baseY} L${run.map((p) => `${p.x},${p.y}`).join(' L')} L${run[run.length - 1]!.x},${baseY} Z`} fill={`url(#${uid}-g)`} stroke="none" />
          ))}

          {series.map((s) => (
            <g key={s.name} className={s.className}>
              {runs(s).map((run, i) =>
                run.length === 1 ? (
                  s.marker === 'circle'
                    ? <circle key={i} cx={run[0]!.x} cy={run[0]!.y} r={single ? 5.5 : 3.5} stroke="none" />
                    : <rect key={i} x={run[0]!.x - 3.5} y={run[0]!.y - 3.5} width={7} height={7} stroke="none" />
                ) : (
                  <polyline key={i} points={run.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" strokeWidth={2.25} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
                ),
              )}
            </g>
          ))}

          {/* the reading under the pointer / keyboard */}
          {activeTime && (
            <g pointerEvents="none">
              <line x1={activeX} y1={PAD_T} x2={activeX} y2={baseY} className="stroke-text-muted" strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => {
                const v = valueAt(s, activeTime)
                if (v === null) return null
                return (
                  <g key={s.name} className={s.className}>
                    <circle cx={activeX} cy={y(Number(v))} r={5} className="stroke-surface" strokeWidth={2} />
                  </g>
                )
              })}
            </g>
          )}
        </svg>

        {activeTime && (
          <div
            role="presentation" aria-hidden="true"
            style={{ left: `${tipLeft}%` }}
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-card"
          >
            <p className="whitespace-nowrap font-medium text-text-primary">{span <= 2 * DAY ? fmtDateTime(Date.parse(activeTime)) : fmtDate(Date.parse(activeTime))}</p>
            {series.map((s) => {
              const v = valueAt(s, activeTime)
              return (
                <p key={s.name} className="whitespace-nowrap tabular-nums text-text-secondary">
                  {series.length > 1 && <span>{s.name}: </span>}
                  {v === null ? <span className="text-text-muted">Not known</span> : <span className="font-semibold text-text-primary">{money(v)}</span>}
                </p>
              )
            })}
          </div>
        )}
      </div>

      {/* Read out the value under the pointer or keyboard focus. */}
      <p className="sr-only" aria-live="polite">
        {activeTime ? `${fmtDateTime(Date.parse(activeTime))}. ${series.map((s) => { const v = valueAt(s, activeTime); return `${s.name} ${v === null ? 'not known' : money(v)}` }).join('. ')}` : ''}
      </p>

      {series.length > 1 && (
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
      )}
      {single && singleNote && <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-xs text-text-secondary">{singleNote}</p>}
      <p className="text-xs text-text-muted">Gaps mean the value is unknown at that time. Amounts are in {currency}.</p>
    </figure>
  )
}
