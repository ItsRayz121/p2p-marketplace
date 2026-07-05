'use client'
import { useEffect, useState } from 'react'
import { ctmApi } from '@/lib/api'

type Insight = {
  avg12h: number | null
  buyAvg12h: number | null
  sellAvg12h: number | null
  previous12hAvg: number | null
  changePercent: number | null
  changePercent1h: number | null
  lastTradePrice: number | null
  lastTradedAt: string | null
  recentPrices: { price: number; at: string }[]
  dataSource: 'completed_trades' | 'active_listings' | 'none'
  sampleSize: number
  lowData: boolean
}

function fmt(n: number | null) {
  if (n === null) return null
  return n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Tiny inline sparkline (no external lib). Colours by net direction across the
// series (last vs first). Renders nothing for < 2 points.
function Sparkline({ points, className }: { points: number[]; className?: string }) {
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

function ChangeChip({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null
  const up = pct > 0, down = pct < 0
  return (
    <span className={`font-semibold ${up ? 'text-emerald-600' : down ? 'text-red-500' : 'text-text-muted'}`}>
      {up ? '▲' : down ? '▼' : '—'} {Math.abs(pct).toFixed(2)}% {label}
    </span>
  )
}

interface Props {
  tokenId: string
  tokenSymbol: string
  side: 'buy' | 'sell'
}

export function MarketInsightWidget({ tokenId, tokenSymbol, side }: Props) {
  const [insight, setInsight] = useState<Insight | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!tokenId) { setInsight(null); return }
    setLoading(true)
    ctmApi.getTokenMarketInsight(tokenId)
      .then((data) => setInsight(data as Insight))
      .catch(() => setInsight(null))
      .finally(() => setLoading(false))
  }, [tokenId])

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs text-text-muted animate-pulse">
        Loading market data…
      </div>
    )
  }

  if (!insight) return null

  const hasNoData = insight.dataSource === 'none' || insight.avg12h === null
  const sourceLabel = insight.dataSource === 'completed_trades'
    ? 'from trades'
    : insight.dataSource === 'active_listings'
    ? 'from listings'
    : null

  // Competitive range: ±3% of average for the relevant side
  const rangeBase = (side === 'sell' ? insight.sellAvg12h : insight.buyAvg12h) ?? insight.avg12h
  const rangeMin = rangeBase !== null ? parseFloat((rangeBase * 0.97).toFixed(2)) : null
  const rangeMax = rangeBase !== null ? parseFloat((rangeBase * 1.03).toFixed(2)) : null

  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3 text-xs space-y-1.5">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-text-primary text-[11px] uppercase tracking-wide">
          Market insight · {tokenSymbol}
        </span>
        <div className="flex items-center gap-1.5">
          {insight.lowData && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium text-[10px]">
              Low data
            </span>
          )}
          {sourceLabel && (
            <span className="text-text-muted text-[10px]">{sourceLabel}</span>
          )}
        </div>
      </div>

      {hasNoData ? (
        <p className="text-text-muted">No recent market data yet.</p>
      ) : (
        <>
          {/* Price rows */}
          <div className="grid grid-cols-3 gap-x-3 gap-y-1">
            {insight.avg12h !== null && (
              <div>
                <span className="text-text-muted block">Avg 12h</span>
                <span className="font-semibold text-text-primary">PKR {fmt(insight.avg12h)}</span>
              </div>
            )}
            {insight.buyAvg12h !== null && (
              <div>
                <span className="text-text-muted block">Buy avg</span>
                <span className="font-semibold text-emerald-600">PKR {fmt(insight.buyAvg12h)}</span>
              </div>
            )}
            {insight.sellAvg12h !== null && (
              <div>
                <span className="text-text-muted block">Sell avg</span>
                <span className="font-semibold text-blue-600 dark:text-blue-400">PKR {fmt(insight.sellAvg12h)}</span>
              </div>
            )}
          </div>

          {/* Change % (1h + 12h) + last trade + sparkline */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <ChangeChip label="last 1h" pct={insight.changePercent1h} />
              <ChangeChip label="last 12h" pct={insight.changePercent} />
              {insight.lastTradePrice !== null && (
                <span className="text-text-muted">
                  Last trade: PKR {fmt(insight.lastTradePrice)} per {tokenSymbol}
                </span>
              )}
            </div>
            {insight.recentPrices && insight.recentPrices.length >= 2 && (
              <Sparkline points={insight.recentPrices.map((p) => p.price)} className="h-7 w-24 flex-shrink-0" />
            )}
          </div>

          {/* Helper text */}
          {rangeBase !== null && rangeMin !== null && rangeMax !== null && (
            <p className="text-text-muted pt-0.5 border-t border-border/60">
              {side === 'sell'
                ? `Competitive sell range: PKR ${fmt(rangeMin)}–${fmt(rangeMax)} per ${tokenSymbol}`
                : `Competitive buy range: PKR ${fmt(rangeMin)}–${fmt(rangeMax)} per ${tokenSymbol}`}
            </p>
          )}
        </>
      )}
    </div>
  )
}
