'use client'
import { useEffect, useState } from 'react'
import { ctmApi } from '@/lib/api'

type Insight = {
  avg12h: number | null
  buyAvg12h: number | null
  sellAvg12h: number | null
  previous12hAvg: number | null
  changePercent: number | null
  lastTradePrice: number | null
  lastTradedAt: string | null
  dataSource: 'completed_trades' | 'active_listings' | 'none'
  sampleSize: number
  lowData: boolean
}

function fmt(n: number | null) {
  if (n === null) return null
  return n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

  const changeUp = insight.changePercent !== null && insight.changePercent > 0
  const changeDown = insight.changePercent !== null && insight.changePercent < 0

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

          {/* Change % + last trade */}
          <div className="flex items-center gap-3 flex-wrap">
            {insight.changePercent !== null && (
              <span className={`font-semibold ${changeUp ? 'text-emerald-600' : changeDown ? 'text-red-500' : 'text-text-muted'}`}>
                {changeUp ? '▲' : changeDown ? '▼' : '—'} {Math.abs(insight.changePercent).toFixed(2)}% last 12h
              </span>
            )}
            {insight.lastTradePrice !== null && (
              <span className="text-text-muted">
                Last trade: PKR {fmt(insight.lastTradePrice)} per {tokenSymbol}
              </span>
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
