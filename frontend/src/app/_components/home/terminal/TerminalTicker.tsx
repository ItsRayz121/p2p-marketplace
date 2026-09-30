'use client'

import { useTerminal } from './TerminalProvider'
import { changeView, fmtPrice } from './format'

/** Scrolling price strip: every market with its PKR price and 24h move. */
export function TerminalTicker() {
  const { overview, select } = useTerminal()
  const rows = (overview?.rows ?? []).filter((r) => r.lastPricePkr !== null)
  if (!rows.length) return null

  // Repeat short lists so the strip is always wider than the viewport, then
  // double it so the -50% marquee loop is seamless.
  const base = rows.length < 6 ? [...rows, ...rows, ...rows] : rows
  const loop = [...base, ...base]
  const duration = Math.max(base.length * 5, 30)

  return (
    <div className="border-b border-border bg-surface-alt/60 overflow-hidden" aria-label="Live market prices">
      <div
        className="flex w-max gap-6 px-4 py-2 font-mono text-[11px] whitespace-nowrap hover:[animation-play-state:paused]"
        // Longhands, not the `animation` shorthand: an inline shorthand would
        // pin animation-play-state and defeat the hover-to-pause class.
        style={{ animationName: 'marquee', animationDuration: `${duration}s`, animationTimingFunction: 'linear', animationIterationCount: 'infinite' }}
      >
        {loop.map((r, i) => {
          const ch = changeView(r.changePercent24h)
          return (
            <button
              key={`${r.slug}-${i}`}
              type="button"
              onClick={() => { select(r.slug); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              className="inline-flex items-center gap-2 hover:text-primary transition-colors"
              tabIndex={i < base.length ? 0 : -1}
              aria-hidden={i < base.length ? undefined : true}
            >
              <span className="text-text-muted">{r.symbol}/PKR</span>
              <span className="text-text-primary tabular-nums">{fmtPrice(r.lastPricePkr)}</span>
              <span className={ch.cls}>{ch.label}</span>
              <span className="text-border" aria-hidden>│</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
