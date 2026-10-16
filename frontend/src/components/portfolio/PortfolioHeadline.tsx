import type { PortfolioSummaryResponse } from '@/lib/portfolio/types'
import { formatDecimal, formatSigned } from '@/lib/portfolio/format'

function Card({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-bold text-text-primary mt-1 break-words">{value}</p>
      <p className="text-xs text-text-muted mt-1">{note}</p>
    </div>
  )
}

/**
 * Headline numbers for the tracked portfolio. Totals cover only what is known: anything unpriced,
 * of unknown cost, or sold beyond the recorded history is listed in the notice and excluded, never
 * counted as zero.
 */
export function PortfolioHeadline({ data, names }: { data: PortfolioSummaryResponse; names: Record<string, string> }) {
  const s = data.summary
  const label = (ids: string[]) => ids.map((id) => names[id] ?? 'Unnamed token').join(', ')
  const asOf = new Date(data.asOf).toLocaleString()

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="Priced holdings" value={`PKR ${formatDecimal(s.pricedValue)}`} note="Tokens where you entered a current price" />
        <Card label="Realized profit / loss" value={`PKR ${formatSigned(s.knownRealized)}`} note="From sales you recorded (FIFO)" />
        <Card label="Unrealized profit / loss" value={`PKR ${formatSigned(s.knownUnrealized)}`} note="Only tokens with a price and a known cost" />
        <Card label="Total known profit / loss" value={`PKR ${formatSigned(s.knownTotalPnl)}`} note="Realized plus unrealized, known parts only" />
      </div>

      {s.partial ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 space-y-1">
          <p className="font-semibold">Partial data: these totals leave out the items below. They are not counted as zero.</p>
          {s.unpricedAssets.length > 0 && <p>No current price: {label(s.unpricedAssets)}</p>}
          {s.unknownBasisAssets.length > 0 && <p>Unknown cost: {label(s.unknownBasisAssets)}</p>}
          {s.unresolvedAssets.length > 0 && <p>Sold more than recorded (add opening holdings): {label(s.unresolvedAssets)}</p>}
        </div>
      ) : (
        <p className="text-xs text-text-muted">Every recorded token is priced and has a known cost.</p>
      )}

      <p className="text-xs text-text-muted">
        Based on the transactions and prices you entered, in PKR, as of {asOf}. This is not verified ownership, an exit price, or tax advice. Method: FIFO.
      </p>
    </div>
  )
}
