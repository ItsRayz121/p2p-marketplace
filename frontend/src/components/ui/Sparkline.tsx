// Tiny inline sparkline (no external lib). Colours by net direction across the
// series (last vs first). Renders nothing for < 2 points. Shared by the Markets
// list/detail pages and by MarketInsightWidget.
export function Sparkline({ points, className, minSpanPct }: {
  points: number[]
  className?: string
  /** Opt-in: treat the vertical range as at least this fraction of the average value (e.g. 0.005 = 0.5%),
   *  so a near-flat series draws as near-flat instead of being stretched to full height. */
  minSpanPct?: number
}) {
  if (points.length < 2) return null
  const w = 120, h = 28, pad = 2
  let min = Math.min(...points)
  let max = Math.max(...points)
  if (minSpanPct && minSpanPct > 0) {
    const mean = points.reduce((s, v) => s + v, 0) / points.length
    const floor = Math.abs(mean) * minSpanPct
    if (max - min < floor) { const mid = (max + min) / 2; min = mid - floor / 2; max = mid + floor / 2 }
  }
  const span = max - min || 1
  const step = (w - pad * 2) / (points.length - 1)
  const coords = points.map((p, i) => {
    const x = pad + i * step
    const y = pad + (h - pad * 2) * (1 - (p - min) / span)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const up = points[points.length - 1] >= points[0]
  const stroke = up ? '#10b981' : '#ef4444'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className={className} preserveAspectRatio="none" aria-hidden>
      <polyline points={coords.join(' ')} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
