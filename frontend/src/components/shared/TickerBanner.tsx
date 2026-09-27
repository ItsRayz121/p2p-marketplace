'use client'
import type { ReactNode } from 'react'

export interface TickerBannerItem {
  key: string
  node: ReactNode
}

/** Horizontal auto-scrolling marquee of recent activity (trades, gas purchases, …).
 * Shared by CTM, USDT Marketplace, Gas Fees and the Home page so the ticker
 * mechanics (and scroll pacing) stay identical everywhere it's used. */
export function TickerBanner({
  items,
  label = 'Recent Trades',
  secondsPerItem = 6,
  minDurationSeconds = 30,
}: {
  items: TickerBannerItem[]
  label?: string
  secondsPerItem?: number
  minDurationSeconds?: number
}) {
  if (!items.length) return null
  const doubled = [...items, ...items]
  const marqueeDuration = Math.max(items.length * secondsPerItem, minDurationSeconds)
  return (
    <div className="relative bg-surface border border-border rounded-xl overflow-hidden mb-4">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-alt">
        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex overflow-hidden">
        <div
          className="flex gap-3 px-3 py-2 whitespace-nowrap"
          style={{ animation: `marquee ${marqueeDuration}s linear infinite` }}
        >
          {doubled.map((it, i) => (
            <span
              key={`${it.key}-${i}`}
              className="inline-flex items-center gap-1.5 text-xs text-text-secondary flex-shrink-0 border-r border-border pr-3 last:border-0"
            >
              {it.node}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
