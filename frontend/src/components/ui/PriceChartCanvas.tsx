'use client'

import { useEffect, useRef, useState } from 'react'

// Shared hand-rolled SVG price chart (no chart library). Renders candlesticks
// when there are enough buckets, otherwise a clean area line. Used by both the
// CTM token chart and the USDT-marketplace chart so they look identical.

export interface ChartCandle { t: string; o: number; h: number; l: number; c: number; n: number }
export interface ChartPoint { t: string; p: number }

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

export function PriceChartCanvas({
  candles, points, hasCandles, toDisplay, format, height = 240, yUnit,
}: {
  candles: ChartCandle[]
  points: ChartPoint[]
  hasCandles: boolean
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

  const useCandles = hasCandles

  const values = useCandles
    ? candles.flatMap((c) => [toDisplay(c.h), toDisplay(c.l)])
    : points.map((p) => toDisplay(p.p))
  const min = Math.min(...values)
  const max = Math.max(...values)
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

  // X-axis time labels at start / middle / end of the visible data.
  const times = useCandles ? candles.map((c) => c.t) : points.map((p) => p.t)
  const spanMs = times.length >= 2
    ? Math.max(new Date(times[times.length - 1]).getTime() - new Date(times[0]).getTime(), 0)
    : 0
  const xTicks = times.length === 0
    ? []
    : (times.length === 1
        ? [0]
        : [0, Math.floor((times.length - 1) / 2), times.length - 1])
  const seenX = new Set<number>()

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={H} className="block" role="img" aria-label="Price chart">
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
          if (seenX.has(idx)) return null
          seenX.add(idx)
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
            const o = toDisplay(c.o), cl = toDisplay(c.c), h = toDisplay(c.h), l = toDisplay(c.l)
            const up = cl >= o
            const color = up ? '#10b981' : '#ef4444'
            const cx = xAt(i)
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
          <AreaLine points={points.map((p, i) => ({ x: xAt(i), yv: y(toDisplay(p.p)) }))} baseY={padT + chartH} />
        )}
      </svg>
    </div>
  )
}

function AreaLine({ points, baseY }: { points: { x: number; yv: number }[]; baseY: number }) {
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
      {points.length === 1 && <circle cx={points[0].x} cy={points[0].yv} r={2.5} fill={stroke} />}
    </>
  )
}
