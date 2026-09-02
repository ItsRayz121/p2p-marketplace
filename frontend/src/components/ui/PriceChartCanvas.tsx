'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// Shared hand-rolled SVG price chart (no chart library). Renders a trend line
// (optionally with a dot on every real trade bucket) or candlesticks. Used by
// both the CTM token chart and the USDT-marketplace chart so they look
// identical. Quiet buckets (no trade) carry the previous close forward and are
// drawn muted, so the time axis stays continuous on a low-volume market.

export interface ChartCandle { t: string; o: number; h: number; l: number; c: number; n: number; filled?: boolean }
export interface ChartPoint { t: string; p: number; filled?: boolean }

export type ChartView = 'line' | 'dots' | 'candles'

// Generate ~`count` rounded "nice" tick values spanning [lo, hi]. Keeps the
// y-axis readable (e.g. 250 / 275 / 300 instead of 229.38 / 748.5 / 1267.62).
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo
  if (!(span > 0)) return [hi]
  const rawStep = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const start = Math.ceil(lo / step) * step
  const ticks: number[] = []
  for (let v = start; v <= hi + step * 1e-6; v += step) ticks.push(v)
  return ticks.length >= 2 ? ticks : [lo, hi]
}

const DAY_MS = 24 * 60 * 60 * 1000

function formatXLabel(iso: string, spanMs: number): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  if (spanMs <= 2 * DAY_MS) {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (spanMs <= 400 * DAY_MS) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

function formatHoverDate(iso: string, spanMs: number): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  if (spanMs <= 2 * DAY_MS) {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (spanMs <= 400 * DAY_MS) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export function PriceChartCanvas({
  candles, points, view, toDisplay, format, height = 240, yUnit,
}: {
  candles: ChartCandle[]
  points: ChartPoint[]
  /** How to draw the series. */
  view: ChartView
  /** Convert a stored (base-currency) price into the display value. */
  toDisplay: (base: number) => number
  /** Format a display value for the y-axis labels. */
  format: (v: number) => string
  height?: number
  /** Short caption for what the vertical axis measures, e.g. "PKR / USDT". */
  yUnit?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setWidth(Math.floor(w))
    })
    ro.observe(el)
    setWidth(Math.floor(el.getBoundingClientRect().width) || 640)
    return () => ro.disconnect()
  }, [])

  const H = height
  const padL = 8, padR = 56, padT = 16, padB = 22
  const chartW = Math.max(width - padL - padR, 10)
  const chartH = H - padT - padB

  const useCandles = view === 'candles'
  const showDots = view === 'dots'

  const values = useCandles
    ? candles.flatMap((c) => (c.filled ? [toDisplay(c.c)] : [toDisplay(c.h), toDisplay(c.l)]))
    : points.map((p) => toDisplay(p.p))
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 1
  const span = max - min || Math.abs(max) || 1
  const lo = min - span * 0.06
  const hi = max + span * 0.06
  const vSpan = hi - lo || 1
  const y = (v: number) => padT + chartH * (1 - (v - lo) / vSpan)

  const n = useCandles ? candles.length : points.length
  const slot = chartW / Math.max(n, 1)
  const xAt = (i: number) => padL + slot * (i + 0.5)

  // Rounded, evenly-spaced y-axis levels (kept inside the visible band).
  const gridVals = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi)

  // X-axis time labels spread across the visible data (start / 25 / 50 / 75 / end).
  const times = useCandles ? candles.map((c) => c.t) : points.map((p) => p.t)
  const spanMs = times.length >= 2
    ? Math.max(new Date(times[times.length - 1]).getTime() - new Date(times[0]).getTime(), 0)
    : 0
  const xTicks = useMemo(() => {
    const last = times.length - 1
    if (last < 0) return []
    if (last <= 1) return Array.from({ length: times.length }, (_, i) => i)
    return Array.from(new Set([0, Math.round(last * 0.25), Math.round(last * 0.5), Math.round(last * 0.75), last]))
  }, [times.length])

  // ── hover ────────────────────────────────────────────────────────────────
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * width
    const idx = Math.round((mx - padL) / slot - 0.5)
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)))
  }
  const onLeave = () => setHoverIdx(null)

  const hoverCandle = hoverIdx != null && useCandles ? candles[hoverIdx] : null
  const hoverPoint = hoverIdx != null && !useCandles ? points[hoverIdx] : null
  const hoverX = hoverIdx != null ? xAt(hoverIdx) : 0
  const hoverBasePrice = hoverCandle ? hoverCandle.c : hoverPoint ? hoverPoint.p : 0
  const hoverPrice = toDisplay(hoverBasePrice)
  const hoverTradeN = hoverCandle ? hoverCandle.n : 0
  const hoverIsReal = hoverCandle ? hoverCandle.n > 0 : hoverPoint ? !hoverPoint.filled : false
  const tipLeft = Math.min(Math.max(hoverX, 44), width - 44)
  const tipFlip = hoverIdx != null && y(hoverPrice) < 54

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        width={width} height={H} className="block select-none" role="img" aria-label="Price chart"
        onMouseMove={onMove} onMouseLeave={onLeave}
      >
        {/* Vertical-axis unit caption */}
        {yUnit && (
          <text x={width - 2} y={11} textAnchor="end" className="fill-text-muted" fontSize={9} fontWeight={600}>
            {yUnit}
          </text>
        )}

        {gridVals.map((gv, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + chartW} y1={y(gv)} y2={y(gv)} stroke="currentColor" className="text-border" strokeWidth={1} strokeDasharray="3 3" />
            <text x={padL + chartW + 6} y={y(gv) + 3} className="fill-text-muted" fontSize={10}>{format(gv)}</text>
          </g>
        ))}

        {/* X-axis time labels */}
        {xTicks.map((idx, k) => {
          const anchor = k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'
          const cx = k === 0 ? padL : k === xTicks.length - 1 ? padL + chartW : xAt(idx)
          return (
            <text key={`x-${idx}`} x={cx} y={H - 6} textAnchor={anchor} className="fill-text-muted" fontSize={9}>
              {formatXLabel(times[idx], spanMs)}
            </text>
          )
        })}

        {useCandles ? (
          candles.map((c, i) => {
            const cx = xAt(i)
            if (c.filled) {
              // Quiet bucket — just a faint tick at the carried-forward close.
              const yc = y(toDisplay(c.c))
              const w = Math.max(Math.min(slot * 0.6, 14), 2)
              return (
                <line key={i} x1={cx - w / 2} x2={cx + w / 2} y1={yc} y2={yc} stroke="currentColor" className="text-text-muted" strokeWidth={1} opacity={0.45} />
              )
            }
            const o = toDisplay(c.o), cl = toDisplay(c.c), h = toDisplay(c.h), l = toDisplay(c.l)
            const up = cl >= o
            const color = up ? '#10b981' : '#ef4444'
            const bodyW = Math.max(Math.min(slot * 0.6, 14), 2)
            const yO = y(o), yC = y(cl)
            const bodyTop = Math.min(yO, yC)
            const bodyH = Math.max(Math.abs(yO - yC), 1)
            return (
              <g key={i}>
                <line x1={cx} x2={cx} y1={y(h)} y2={y(l)} stroke={color} strokeWidth={1} />
                <rect x={cx - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color} rx={1} />
              </g>
            )
          })
        ) : (
          <AreaLine
            points={points.map((p, i) => ({ x: xAt(i), yv: y(toDisplay(p.p)), real: !p.filled }))}
            baseY={padT + chartH}
            showDots={showDots}
          />
        )}

        {/* Hover crosshair */}
        {hoverIdx != null && n > 0 && (
          <g pointerEvents="none">
            <line x1={hoverX} x2={hoverX} y1={padT} y2={padT + chartH} stroke="currentColor" className="text-text-muted" strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />
            <circle cx={hoverX} cy={y(hoverPrice)} r={3.5} fill={hoverIsReal ? '#10b981' : 'currentColor'} className={hoverIsReal ? '' : 'text-text-muted'} stroke="var(--color-surface, #fff)" strokeWidth={1.5} />
          </g>
        )}
      </svg>

      {/* Hover tooltip */}
      {hoverIdx != null && n > 0 && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] shadow-lg"
          style={{ left: tipLeft, top: tipFlip ? y(hoverPrice) + 12 : y(hoverPrice) - 12, transform: `translate(-50%, ${tipFlip ? '0' : '-100%'})` }}
        >
          <div className="mb-0.5 text-text-muted">{formatHoverDate(times[hoverIdx], spanMs)}</div>
          {hoverCandle && hoverIsReal ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
              <span className="text-text-muted">O</span><span className="text-right font-medium text-text-primary">{format(toDisplay(hoverCandle.o))}</span>
              <span className="text-text-muted">H</span><span className="text-right font-medium text-text-primary">{format(toDisplay(hoverCandle.h))}</span>
              <span className="text-text-muted">L</span><span className="text-right font-medium text-text-primary">{format(toDisplay(hoverCandle.l))}</span>
              <span className="text-text-muted">C</span><span className="text-right font-medium text-text-primary">{format(toDisplay(hoverCandle.c))}</span>
            </div>
          ) : (
            <div className="font-semibold tabular-nums text-text-primary">{format(hoverPrice)}</div>
          )}
          <div className="mt-0.5 text-text-muted">
            {hoverIsReal
              ? (hoverCandle ? `${hoverTradeN} trade${hoverTradeN === 1 ? '' : 's'}` : 'traded')
              : 'no trades · carried'}
          </div>
        </div>
      )}
    </div>
  )
}

function AreaLine({ points, baseY, showDots }: { points: { x: number; yv: number; real: boolean }[]; baseY: number; showDots: boolean }) {
  if (points.length === 0) return null
  const up = points[points.length - 1].yv <= points[0].yv // lower y = higher price
  const stroke = up ? '#10b981' : '#ef4444'
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.yv.toFixed(1)}`).join(' ')
  const area = `${line} L${points[points.length - 1].x.toFixed(1)},${baseY} L${points[0].x.toFixed(1)},${baseY} Z`
  const gradId = `price-area-${up ? 'up' : 'dn'}`
  return (
    <>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      {showDots
        ? points.filter((p) => p.real).map((p, i) => (
            <circle key={i} cx={p.x} cy={p.yv} r={2.5} fill={stroke} stroke="var(--color-surface, #fff)" strokeWidth={1} />
          ))
        : points.length === 1 && <circle cx={points[0].x} cy={points[0].yv} r={2.5} fill={stroke} />}
    </>
  )
}
