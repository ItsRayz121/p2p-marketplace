'use client'

import { useEffect, useRef, useState } from 'react'

// Shared hand-rolled SVG price chart (no chart library). Renders candlesticks
// when there are enough buckets, otherwise a clean area line. Used by both the
// CTM token chart and the USDT-marketplace chart so they look identical.

export interface ChartCandle { t: string; o: number; h: number; l: number; c: number; n: number }
export interface ChartPoint { t: string; p: number }

export function PriceChartCanvas({
  candles, points, hasCandles, toDisplay, format, height = 240,
}: {
  candles: ChartCandle[]
  points: ChartPoint[]
  hasCandles: boolean
  /** Convert a stored (base-currency) price into the display value. */
  toDisplay: (base: number) => number
  /** Format a display value for the y-axis labels. */
  format: (v: number) => string
  height?: number
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
  const padL = 8, padR = 52, padT = 10, padB = 20
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

  const gridVals = [hi, (hi + lo) / 2, lo]

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={H} className="block" role="img" aria-label="Price chart">
        {gridVals.map((gv, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + chartW} y1={y(gv)} y2={y(gv)} stroke="currentColor" className="text-border" strokeWidth={1} strokeDasharray="3 3" />
            <text x={padL + chartW + 6} y={y(gv) + 3} className="fill-text-muted" fontSize={10}>{format(gv)}</text>
          </g>
        ))}

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
