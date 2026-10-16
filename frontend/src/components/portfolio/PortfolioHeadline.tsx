import type { PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { computeFigures, type Figure } from '@/lib/portfolio/engine/figures'
import { formatDecimal, formatSigned, isNegative } from '@/lib/portfolio/format'
import { InfoTip } from './InfoTip'

type Kind = 'value' | 'realized' | 'unrealized'

/** What a card says when there is something to measure but nothing could be. Never a number. */
const UNAVAILABLE: Record<Kind, string> = { value: 'Value unavailable', realized: 'Not known yet', unrealized: 'Not known yet' }

function Card({ label, tip, children, note }: { label: string; tip: string; children: React.ReactNode; note: string }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4">
      <p className="text-xs text-text-muted">{label}<InfoTip text={tip} /></p>
      <p className="text-lg font-bold text-text-primary mt-1 break-words">{children}</p>
      <p className="text-xs text-text-muted mt-1">{note}</p>
    </div>
  )
}

function Partial({ f, noun }: { f: Figure; noun: string }) {
  return (
    <span className="ml-2 align-middle inline-block rounded-full bg-amber-500/10 border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-800">
      Partial · {f.covered} of {f.total} {noun}
    </span>
  )
}

/** A figure as text: a plain number only when it is known; otherwise the reason it is not. */
function FigureText({ f, kind, cur, signed }: { f: Figure; kind: Kind; cur: string; signed: boolean }) {
  if (f.state === 'unavailable' || f.amount === null) return <span className="text-text-secondary">{UNAVAILABLE[kind]}</span>
  const shown = signed ? formatSigned(f.amount) : formatDecimal(f.amount)
  return (
    <span className={signed && isNegative(f.amount) ? 'text-danger' : undefined}>
      {cur} {shown}
      {f.state === 'partial' && <Partial f={f} noun={kind === 'realized' ? 'sales' : 'tokens'} />}
    </span>
  )
}

/**
 * Headline numbers for the tracked portfolio. A figure is a plain number only when everything behind
 * it is known; a missing price or cost is stated as such and never printed as 0.
 */
export function PortfolioHeadline({
  data, trackedHeld, trackedTotal,
}: {
  data: PortfolioSummaryResponse
  /** Active tokens with a recorded balance above zero. */
  trackedHeld: number
  /** All active (not archived) tokens. */
  trackedTotal: number
}) {
  const s = data.summary
  const cur = data.currency
  const asOf = new Date(data.asOf).toLocaleString()
  // The states come from the positions; the amounts are the server's own totals so there is one source of truth.
  const base = computeFigures(s.positions, data.fxUnavailableAssets.length)
  const withAmount = (f: Figure, amount: string): Figure => (f.state === 'unavailable' || f.total === 0 ? f : { ...f, amount })
  const fig = {
    value: withAmount(base.value, s.pricedValue),
    unrealized: withAmount(base.unrealized, s.knownUnrealized),
    realized: withAmount(base.realized, s.knownRealized),
    total: withAmount(base.total, s.knownTotalPnl),
  }

  const valueNote = fig.value.state === 'unavailable'
    ? 'Add a current price to see it'
    : fig.value.state === 'partial' ? 'Counts only tokens that have a price' : 'From the prices you entered and RupChain trades'
  const realizedNote = fig.realized.total === 0
    ? 'No sales recorded yet'
    : fig.realized.state === 'unavailable' ? 'The cost of what you sold is not recorded' : 'From sales you recorded (FIFO)'
  const unrealizedNote = fig.unrealized.state === 'unavailable'
    ? 'Needs a price and a recorded cost'
    : fig.unrealized.state === 'partial' ? 'Counts only tokens with a price and a cost' : 'Value now minus what you paid'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="Estimated Portfolio Value" tip="Quantity times the current price, for tokens that have a price. An estimate, not an amount you could sell for." note={valueNote}>
          <FigureText f={fig.value} kind="value" cur={cur} signed={false} />
        </Card>
        <Card label="Known Realized Profit / Loss" tip="Profit or loss on units you already sold, using FIFO. Only sales whose cost is recorded are counted." note={realizedNote}>
          <FigureText f={fig.realized} kind="realized" cur={cur} signed />
        </Card>
        <Card label="Unrealized Profit / Loss" tip="What you hold now, valued at the current price, minus what it cost you. Not locked in until you sell." note={unrealizedNote}>
          <FigureText f={fig.unrealized} kind="unrealized" cur={cur} signed />
        </Card>
        <Card label="Total Tracked Assets" tip="Tokens you currently hold according to your records. Archived tokens are not counted." note={`${trackedTotal} ${trackedTotal === 1 ? 'token' : 'tokens'} tracked in total`}>
          {trackedHeld}
        </Card>
      </div>

      {fig.total.state === 'known' && fig.total.total > 0 && fig.total.amount !== null && (
        <p className="text-xs text-text-secondary">
          Realized plus unrealized: <span className="font-semibold">{cur} {formatSigned(fig.total.amount)}</span>
        </p>
      )}

      {s.partial
        ? <p className="text-xs text-text-muted">Some figures leave out what is missing. See what needs attention below. Missing values are never counted as zero.</p>
        : <p className="text-xs text-text-muted">Every recorded token is priced and has a recorded cost.</p>}

      <p className="text-xs text-text-muted">
        Based on your transactions and prices (RupChain trades use the latest platform trade price), in {cur}, as of {asOf}.
        {data.fx.usdtPkr !== null && <> Current prices use today&apos;s RupChain rate of {formatDecimal(data.fx.usdtPkr)} PKR per USDT; each entry uses the rate recorded with it, and imported RupChain trades without one use today&apos;s rate.</>}
        {' '}This is not verified ownership, an exit price, or tax advice. Method: FIFO.
      </p>
    </div>
  )
}
