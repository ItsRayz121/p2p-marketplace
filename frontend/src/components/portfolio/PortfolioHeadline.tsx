'use client'

import type { PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { computeFigures, type Figure } from '@/lib/portfolio/engine/figures'
import { formatDecimal, formatSigned, isNegative } from '@/lib/portfolio/format'
import { InfoTip } from './InfoTip'

/** A small status chip for a figure that is only partly known. Never shown for a complete figure. */
function PartialChip({ f, noun }: { f: Figure; noun: string }) {
  return (
    <span
      title={`Only ${f.covered} of ${f.total} ${noun} could be measured. Open Review to complete it.`}
      className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Partial · {f.covered}/{f.total}
    </span>
  )
}

function Metric({ label, tip, className = '', children }: { label: string; tip: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`bg-surface shadow-card rounded-2xl border border-border px-4 py-3 ${className}`}>
      <p className="text-xs font-medium text-text-muted">{label}<InfoTip text={tip} /></p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">{children}</div>
    </div>
  )
}

/** The amount of a figure: a plain number only when something was measured, otherwise "Unavailable", never 0. */
function Amount({ f, cur, signed, noun }: { f: Figure; cur: string; signed: boolean; noun: string }) {
  if (f.state === 'unavailable' || f.amount === null) return <span className="text-lg font-semibold text-text-muted">Unavailable</span>
  const negative = signed && isNegative(f.amount)
  const positive = signed && !negative && !/^[+-]?0+(\.0+)?$/.test(f.amount)
  return (
    <>
      <span className={`text-xl font-bold break-words ${negative ? 'text-danger' : positive ? 'text-success' : 'text-text-primary'}`}>
        {cur} {signed ? formatSigned(f.amount) : formatDecimal(f.amount)}
      </span>
      {f.state === 'partial' && <PartialChip f={f} noun={noun} />}
    </>
  )
}

function MiniStat({ label, f, cur, noun }: { label: string; f: Figure; cur: string; noun: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums"><Amount f={f} cur={cur} signed noun={noun} /></dd>
    </div>
  )
}

/**
 * Headline numbers for the tracked portfolio: value, total profit/loss and tokens held. A figure is a
 * plain number only when everything behind it is known; otherwise it is flagged Partial or Unavailable
 * and is never printed as 0. The sales / holding split sits behind "Breakdown".
 */
export function PortfolioHeadline({ data, trackedHeld }: {
  data: PortfolioSummaryResponse
  /** Active tokens with a recorded balance above zero. */
  trackedHeld: number
}) {
  const s = data.summary
  const cur = data.currency
  const asOf = new Date(data.asOf).toLocaleString()
  // Tokens with a record that has no exchange rate stay in `positions` (their cost is unknown, so their profit is partial).
  const base = computeFigures(s.positions)
  // The states come from the positions; the amounts are the server's own totals so there is one source of truth.
  const withAmount = (f: Figure, amount: string): Figure => (f.state === 'unavailable' || f.total === 0 ? f : { ...f, amount })
  const fig = {
    value: withAmount(base.value, s.pricedValue),
    unrealized: withAmount(base.unrealized, s.knownUnrealized),
    realized: withAmount(base.realized, s.knownRealized),
    total: withAmount(base.total, s.knownTotalPnl),
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Metric className="col-span-2 sm:col-span-1" label="Portfolio Value" tip="Quantity times the current price, for tokens that have a price. An estimate, not an amount you could sell for.">
          <Amount f={fig.value} cur={cur} signed={false} noun="tokens" />
        </Metric>
        <Metric label="Total Profit / Loss" tip="Profit from sales plus holding profit/loss. Only the parts with a recorded cost are counted; a missing cost is never treated as zero.">
          <Amount f={fig.total} cur={cur} signed noun="results" />
        </Metric>
        <Metric label="Assets Held" tip="Tokens you currently hold according to your records. The same in PKR and USDT. Archived tokens are not counted.">
          <span className="text-xl font-bold text-text-primary">{trackedHeld}</span>
        </Metric>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <details className="group">
          <summary className="cursor-pointer select-none font-medium text-primary hover:underline">Breakdown</summary>
          <dl className="mt-2 grid w-[calc(100vw-2rem)] max-w-xl grid-cols-2 gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
            <MiniStat label="Profit from Sales" f={fig.realized} cur={cur} noun="sales" />
            <MiniStat label="Holding Profit / Loss" f={fig.unrealized} cur={cur} noun="tokens" />
          </dl>
        </details>
        <span>
          {cur} · as of {asOf}
          <InfoTip text={`Based on your transactions and prices (RupChain trades use the latest platform trade price). Missing values are never counted as zero.${data.fx.usdtPkr !== null ? ` Current prices use today's RupChain rate of ${formatDecimal(data.fx.usdtPkr)} PKR per USDT; each entry keeps the rate recorded with it.` : ''} Method: FIFO. Not verified ownership, an exit price, or tax advice. Separate from your RupChain wallet balance.`} />
        </span>
      </div>

    </div>
  )
}
