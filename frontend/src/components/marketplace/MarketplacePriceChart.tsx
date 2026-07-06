'use client'

import { useEffect, useState } from 'react'
import { Calculator, X, ArrowLeftRight } from 'lucide-react'
import { marketplaceApi, type UsdtPriceHistory, type CtmPriceRange } from '@/lib/api'
import { PriceChartCanvas } from '@/components/ui/PriceChartCanvas'

// USDT-marketplace price chart. Price = PKR per 1 USDT, sourced entirely from
// completed USDT trades on THIS platform (the same source as the reference
// rate). Candlesticks when there are enough buckets, else an area line.

const RANGES: { key: CtmPriceRange; label: string }[] = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
]

function fmtPkr(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
function fmtUsdt(n: number): string {
  const max = n !== 0 && Math.abs(n) < 1 ? 6 : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })
}

export function MarketplacePriceChart() {
  const [range, setRange] = useState<CtmPriceRange>('30d')
  const [data, setData] = useState<UsdtPriceHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCalc, setShowCalc] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    marketplaceApi.getUsdtPriceHistory(range)
      .then((d) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range])

  const points = data?.points ?? []
  const lastClose = points.length ? points[points.length - 1].p : null
  const firstClose = points.length ? points[0].p : null
  const changePct = lastClose !== null && firstClose !== null && firstClose !== 0
    ? ((lastClose - firstClose) / firstClose) * 100
    : null

  return (
    <div className="relative rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            USDT price
            <span className="rounded bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium normal-case text-text-muted">from platform trades</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-text-primary">
              {lastClose !== null ? `PKR ${fmtPkr(lastClose)}` : '—'}
            </span>
            <span className="text-xs text-text-muted">/ USDT</span>
            {changePct !== null && (
              <span className={`text-sm font-semibold ${changePct > 0 ? 'text-emerald-600' : changePct < 0 ? 'text-red-500' : 'text-text-muted'}`}>
                {changePct > 0 ? '▲' : changePct < 0 ? '▼' : '—'} {Math.abs(changePct).toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        <button
          onClick={() => setShowCalc((v) => !v)}
          aria-label="Price calculator"
          className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
            showCalc ? 'border-primary bg-primary/5 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'
          }`}
        >
          <Calculator size={15} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
              range === r.key ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-surface-alt'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="h-[240px] rounded-lg bg-surface-alt animate-pulse" />
        ) : !data || data.tradeCount === 0 || points.length === 0 ? (
          <div className="h-[240px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border">
            <p className="text-sm font-medium text-text-secondary">No USDT price data for this range yet</p>
            <p className="mt-1 text-xs text-text-muted">
              The chart is built from completed USDT trades on RupChain.{' '}
              {range !== 'all' && <button onClick={() => setRange('all')} className="text-primary font-medium hover:underline">Try “All”.</button>}
            </p>
          </div>
        ) : (
          <PriceChartCanvas
            candles={data.candles}
            points={points}
            hasCandles={data.hasCandles}
            toDisplay={(v) => v}
            format={fmtPkr}
          />
        )}
      </div>

      {data && data.tradeCount > 0 && (
        <p className="mt-2 text-[11px] text-text-muted">
          {data.tradeCount} completed USDT {data.tradeCount === 1 ? 'trade' : 'trades'} in range · {data.hasCandles ? 'candlestick' : 'line'} view · price is PKR per 1 USDT
        </p>
      )}

      {showCalc && (
        <UsdtCalculator rate={lastClose} onClose={() => setShowCalc(false)} />
      )}
    </div>
  )
}

// ─── USDT ⇄ PKR converter popover ─────────────────────────────────────────────

function UsdtCalculator({ rate, onClose }: { rate: number | null; onClose: () => void }) {
  const [amount, setAmount] = useState('100')
  const [unit, setUnit] = useState<'USDT' | 'PKR'>('USDT')

  const amt = parseFloat(amount)
  const valid = !isNaN(amt) && amt >= 0 && rate !== null && rate > 0

  const usdt = valid ? (unit === 'USDT' ? amt : amt / (rate as number)) : null
  const pkr = valid ? (unit === 'PKR' ? amt : amt * (rate as number)) : null

  return (
    <div className="absolute right-4 top-16 z-20 w-72 rounded-xl border border-border bg-surface shadow-xl p-4">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-text-secondary">
          <Calculator size={13} /> USDT calculator
        </span>
        <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary"><X size={15} /></button>
      </div>

      {rate === null ? (
        <p className="mt-3 text-xs text-text-muted">No recent price to calculate from. Try a wider timeframe.</p>
      ) : (
        <>
          <div className="mt-3 flex gap-2">
            <input
              type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 min-w-0 border border-border rounded-lg px-2.5 py-2 text-sm bg-canvas focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <select
              value={unit} onChange={(e) => setUnit(e.target.value as 'USDT' | 'PKR')}
              className="border border-border rounded-lg px-2 py-2 text-sm bg-canvas focus:outline-none"
            >
              <option value="USDT">USDT</option>
              <option value="PKR">PKR</option>
            </select>
          </div>

          <div className="mt-3 space-y-1.5 text-sm">
            {unit !== 'USDT' && (
              <div className="flex items-center justify-between"><span className="text-text-muted">USDT</span><span className="font-semibold text-text-primary">${usdt !== null ? fmtUsdt(usdt) : '—'}</span></div>
            )}
            {unit !== 'PKR' && (
              <div className="flex items-center justify-between"><span className="text-text-muted">PKR</span><span className="font-semibold text-text-primary">PKR {pkr !== null ? fmtPkr(pkr) : '—'}</span></div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-text-muted">
            <ArrowLeftRight size={11} />
            1 USDT = PKR {fmtPkr(rate)} · on RupChain
          </div>
        </>
      )}
    </div>
  )
}
