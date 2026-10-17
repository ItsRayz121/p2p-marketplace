import type { Currency, PortfolioAsset, PortfolioPosition } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'

const COLORS = ['bg-primary', 'bg-sky-500', 'bg-teal-500', 'bg-violet-500', 'bg-amber-500', 'bg-slate-400']
const MAX_SLICES = 5

/**
 * How the priced part of the portfolio splits across tokens. Only tokens with a known value are
 * counted; tokens without a price are named separately and never shown as a zero share.
 */
export function AllocationBar({ positions, assets, currency }: { positions: PortfolioPosition[]; assets: PortfolioAsset[]; currency: Currency }) {
  const names = new Map(assets.filter((a) => !a.archivedAt).map((a) => [a.id, a.symbol || a.name]))
  const priced = positions
    .filter((p) => names.has(p.assetId) && p.value !== null && new D(p.value).gt(0))
    .map((p) => ({ id: p.assetId, name: names.get(p.assetId)!, value: new D(p.value!) }))
    .sort((a, b) => b.value.comparedTo(a.value))
  const unpriced = positions.filter((p) => names.has(p.assetId) && p.value === null && /[1-9]/.test(p.quantity)).length
  if (priced.length < 2) return null

  const total = priced.reduce((s, x) => s.plus(x.value), new D(0))
  const top = priced.slice(0, MAX_SLICES)
  const rest = priced.slice(MAX_SLICES).reduce((s, x) => s.plus(x.value), new D(0))
  const slices = [...top.map((x) => ({ name: x.name, value: x.value })), ...(rest.gt(0) ? [{ name: 'Other', value: rest }] : [])]
    .map((x) => ({ ...x, pct: x.value.div(total).times(100) }))

  return (
    <section aria-labelledby="allocation-heading" className="rounded-2xl border border-border bg-surface shadow-card p-4 space-y-3">
      <h3 id="allocation-heading" className="text-sm font-semibold text-text-primary">Allocation</h3>
      <div role="img" aria-label={`Allocation of priced holdings in ${currency}: ${slices.map((s) => `${s.name} ${s.pct.toFixed(1)}%`).join(', ')}`} className="flex h-3 w-full overflow-hidden rounded-full bg-surface-hover">
        {slices.map((s, i) => <span key={s.name} className={COLORS[i % COLORS.length]} style={{ width: `${s.pct.toFixed(2)}%` }} />)}
      </div>
      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
        {slices.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2 min-w-0">
            <span aria-hidden className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${COLORS[i % COLORS.length]}`} />
            <span className="truncate text-text-secondary">{s.name}</span>
            <span className="ml-auto tabular-nums text-text-primary">{s.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
      {unpriced > 0 && <p className="text-xs text-text-muted">{unpriced} {unpriced === 1 ? 'token has' : 'tokens have'} no price and {unpriced === 1 ? 'is' : 'are'} not included.</p>}
    </section>
  )
}
