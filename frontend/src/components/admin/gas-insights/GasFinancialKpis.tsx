'use client'
import { adminApi, type GasFinancialKpi } from '@/lib/api'
import { useLiveData } from '@/hooks/useLiveData'
import { ErrorState } from '@/components/ui/ErrorState'

const fmtUsd = (n: number) => `$${n.toFixed(2)}`
const fmtPkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`
const fmtPct = (n: number) => `${n.toFixed(1)}%`

function FinancialCards({ kpi }: { kpi: GasFinancialKpi }) {
  const margin = kpi.marginPct
  const marginColor = margin >= 50 ? 'text-success' : margin >= 20 ? 'text-warning' : 'text-danger'
  const marginBg = margin >= 50 ? 'bg-success' : margin >= 20 ? 'bg-warning' : 'bg-danger'
  const cards = [
    { label: 'Orders in range', primary: kpi.totalOrders.toLocaleString(), secondary: `Rate ${fmtUsd(kpi.usdPkrRate)}/USD`, accent: 'text-text-primary' },
    { label: 'Payment received', primary: fmtUsd(kpi.paymentReceivedUsdt), secondary: fmtPkr(kpi.paymentReceivedPkr), accent: 'text-text-primary' },
    { label: 'Gas delivered (cost)', primary: fmtUsd(kpi.gasSpentUsdt), secondary: fmtPkr(kpi.gasSpentPkr), accent: 'text-warning' },
    { label: 'Refunds issued', primary: fmtUsd(kpi.refundCostUsdt), secondary: fmtPkr(kpi.refundCostPkr), accent: kpi.refundCostUsdt > 0 ? 'text-danger' : 'text-text-primary' },
    { label: 'Net after gas & refunds', primary: fmtUsd(kpi.netProfitUsdt), secondary: fmtPkr(kpi.netProfitPkr), accent: kpi.netProfitUsdt >= 0 ? 'text-success' : 'text-danger' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((c, i) => (
        <div key={c.label} className="bg-surface shadow-card border border-border rounded-xl p-4 min-w-0">
          <p className="text-xs text-text-muted font-medium">{c.label}</p>
          <p className={`text-xl font-bold mt-1 tabular-nums ${c.accent}`}>{c.primary}</p>
          <p className="text-xs text-text-muted mt-0.5">{c.secondary}</p>
          {i === 4 && (
            <>
              <div className="mt-2 h-1.5 bg-border rounded-full overflow-hidden">
                <div className={`h-1.5 rounded-full ${marginBg}`} style={{ width: `${Math.min(Math.max(margin, 0), 100)}%` }} />
              </div>
              <p className={`text-xs font-bold mt-1 ${marginColor}`}>{fmtPct(margin)} margin</p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Money recorded for orders CREATED in the selected range (delivered orders for revenue/cost,
 * refunded orders for refunds). Uses the same range as every other card on the Analytics page,
 * so the totals can never describe a different window than the counts beside them.
 */
export function GasFinancialKpis({ from, to, rangeKey }: { from: string | null; to: string; rangeKey: string }) {
  const q = useLiveData(() => adminApi.getGasFinancials(from ?? undefined, to), `fin|${rangeKey}`, 60_000)
  if (q.error && !q.data) return <ErrorState title={q.error} onRetry={q.refresh} />
  if (!q.data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3" aria-busy="true" aria-label="Loading financials">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-28 bg-surface rounded-xl animate-pulse" />)}
      </div>
    )
  }
  return <FinancialCards kpi={q.data} />
}
