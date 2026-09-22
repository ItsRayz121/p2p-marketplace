// Tiny inline sparkline (no external lib). Colours by net direction across the
// series (last vs first). Renders nothing for < 2 points. Shared by the Markets
// list/detail pages and by MarketInsightWidget.
export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  if (points.length < 2) return null
  const w = 120, h = 28, pad = 2
  const min = Math.min(...points)
  const max = Math.max(...points)
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
