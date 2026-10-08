import type { ReferenceItem } from '@/lib/api'

/**
 * Global reference price (7-day) for an asset, from the external provider — clearly labelled as
 * such and never mixed with RupChain's own trade history. Server-renderable (no hooks).
 */

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 6 : 2 })}`

export function ChangeBadge({ pct, period }: { pct: number | null; period: string }) {
  if (pct === null) return <span className="text-sm text-text-muted">— {period}</span>
  const up = pct > 0, down = pct < 0
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-semibold ${up ? 'bg-emerald-500/10 text-emerald-600' : down ? 'bg-red-500/10 text-red-500' : 'bg-surface-alt text-text-muted'}`}
      aria-label={`${up ? 'Up' : down ? 'Down' : 'Unchanged'} ${Math.abs(pct).toFixed(2)} percent over ${period}`}
    >
      <span aria-hidden>{up ? '▲' : down ? '▼' : '—'}</span> {up ? '+' : down ? '−' : ''}{Math.abs(pct).toFixed(2)}% <span className="text-[11px] font-medium opacity-80">{period}</span>
    </span>
  )
}

/** Area sparkline. Direction (not just colour) is also stated in the aria-label and the badge beside it. */
export function ReferenceChart({ points, className = '' }: { points: number[]; className?: string }) {
  if (points.length < 2) return null
  const w = 320, h = 96, pad = 3
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const step = (w - pad * 2) / (points.length - 1)
  const xy = points.map((p, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (p - min) / span)] as const)
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`
  const up = points[points.length - 1]! >= points[0]!
  const color = up ? '#10b981' : '#ef4444'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`w-full ${className}`} preserveAspectRatio="none" role="img" aria-label={`7-day price chart, ${up ? 'rising' : 'falling'}, low ${usd(min)}, high ${usd(max)}`}>
      <polygon points={area} fill={color} opacity={0.1} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function ReferencePriceCard({ item, symbol }: { item: ReferenceItem | null | undefined; symbol: string }) {
  const heading = (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-bold text-text-primary">Global price · 7 days</h2>
      <span className="text-[11px] text-text-muted">Reference data — not RupChain trades</span>
    </div>
  )

  if (!item || item.status !== 'ok') {
    const why = !item ? 'Market data unavailable.'
      : item.status === 'unsupported'
        ? item.reason === 'contract_not_verified' ? 'Market data unavailable — this token is not listed with our data provider on its network.'
        : 'Market data unavailable for this asset.'
        : 'Market data is temporarily unavailable. Trading and payments are not affected.'
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        {heading}
        <p className="text-sm text-text-muted">{why}</p>
      </div>
    )
  }

  const updated = new Date(item.lastUpdated)
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      {heading}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-bold tabular-nums text-text-primary">{usd(item.price)}</span>
        <span className="text-xs text-text-muted">{symbol}/USD</span>
        <ChangeBadge pct={item.change7dPct} period="7D" />
      </div>
      <ReferenceChart points={item.points} className="mt-3 h-24" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-text-muted">
        <span>Source: {item.provider} · prices in {item.currency}</span>
        <span>
          Updated <time dateTime={item.lastUpdated}>{updated.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</time>
          {item.stale && <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">Delayed — provider unreachable</span>}
        </span>
      </div>
      {item.verifiedBy === 'contract' && <p className="mt-1 text-[11px] text-text-muted">Matched by contract address on its own network, not by ticker.</p>}
    </div>
  )
}
