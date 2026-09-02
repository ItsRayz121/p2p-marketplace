'use client'

import { useEffect, useState } from 'react'
import { Calculator, X, ArrowLeftRight, ChevronDown } from 'lucide-react'
import { ctmApi, type CtmPriceHistory, type CtmPriceRange } from '@/lib/api'
import { PriceChartCanvas, type ChartView } from '@/components/ui/PriceChartCanvas'

// Price chart for a CTM token. Prices come from completed trades on THIS
// platform (source of truth), returned in PKR and converted to USDT client-side
// with the platform USDT/PKR reference rate. Renders candlesticks when there
// are enough buckets, otherwise a clean area line for sparse tokens. No chart
// library — hand-rolled SVG, matching the existing sparkline style.

const RANGES: { key: CtmPriceRange; label: string }[] = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'All' },
]

type Currency = 'USDT' | 'PKR'

const VIEWS: { key: ChartView; label: string }[] = [
  { key: 'dots', label: 'Line + dots' },
  { key: 'line', label: 'Line' },
  { key: 'candles', label: 'Candles' },
]

const RANGE_PHRASE: Record<CtmPriceRange, string> = {
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  '1y': 'the last year',
  'all': 'this range',
}

function fmtUsdt(n: number): string {
  const max = n !== 0 && Math.abs(n) < 1 ? 6 : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })
}
function fmtPkr(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
function fmtValue(n: number, cur: Currency): string {
  return cur === 'USDT' ? fmtUsdt(n) : fmtPkr(n)
}

interface Props {
  tokenId: string
  tokenSymbol: string
}

export function CtmPriceChart({ tokenId, tokenSymbol }: Props) {
  const [range, setRange] = useState<CtmPriceRange>('30d')
  const [view, setView] = useState<ChartView>('dots')
  const [currency, setCurrency] = useState<Currency>('USDT')
  const [data, setData] = useState<CtmPriceHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCalc, setShowCalc] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ctmApi.getTokenPriceHistory(tokenId, range)
      .then((d) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tokenId, range])

  const rate = data?.usdtPkrRate ?? null
  const usdtAvailable = rate !== null && rate > 0
  // If USDT isn't available (no reference rate yet), fall back to PKR display.
  const effCurrency: Currency = currency === 'USDT' && !usdtAvailable ? 'PKR' : currency

  // Convert a stored PKR price into the active display currency.
  const conv = (pkr: number): number => (effCurrency === 'USDT' && usdtAvailable ? pkr / (rate as number) : pkr)

  // Last close in display currency + change across the visible range.
  const points = data?.points ?? []
  const lastClose = points.length ? conv(points[points.length - 1].p) : null
  const firstClose = points.length ? conv(points[0].p) : null
  const changePct = lastClose !== null && firstClose !== null && firstClose !== 0
    ? ((lastClose - firstClose) / firstClose) * 100
    : null

  return (
    <div className="relative rounded-xl border border-border bg-surface p-4">
      {/* Header: price + change, controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            <ChevronDown size={13} className={`transition-transform text-text-muted ${collapsed ? '-rotate-90' : ''}`} />
            {tokenSymbol} price chart
            <span className="rounded bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium normal-case text-text-muted">from platform trades</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2 pl-[19px]">
            <span className={`font-bold text-text-primary ${collapsed ? 'text-lg' : 'text-2xl'}`}>
              {lastClose !== null ? `${effCurrency === 'USDT' ? '$' : 'PKR '}${fmtValue(lastClose, effCurrency)}` : '—'}
            </span>
            {changePct !== null && (
              <span className={`text-sm font-semibold ${changePct > 0 ? 'text-emerald-600' : changePct < 0 ? 'text-red-500' : 'text-text-muted'}`}>
                {changePct > 0 ? '▲' : changePct < 0 ? '▼' : '—'} {Math.abs(changePct).toFixed(2)}%
              </span>
            )}
          </div>
        </button>

        {!collapsed && (
        <div className="flex items-center gap-2">
          {/* Currency toggle */}
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {(['USDT', 'PKR'] as Currency[]).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                disabled={c === 'USDT' && !usdtAvailable}
                className={`px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  effCurrency === c ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-alt'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          {/* Calculator */}
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
        )}
      </div>

      {!collapsed && (
      <>
      {/* Timeframes + view */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
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
        <div className="inline-flex rounded-lg border border-border overflow-hidden">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                view === v.key ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-alt'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="mt-3">
        {loading ? (
          <div className="h-[240px] rounded-lg bg-surface-alt animate-pulse" />
        ) : !data || data.tradeCount === 0 || points.length === 0 ? (
          <div className="h-[240px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border">
            <p className="text-sm font-medium text-text-secondary">No trades in {RANGE_PHRASE[range]}</p>
            <p className="mt-1 text-xs text-text-muted">
              The chart is built from completed trades on RupChain.{' '}
              {range !== 'all' && <button onClick={() => setRange('all')} className="text-primary font-medium hover:underline">Try “All”.</button>}
            </p>
          </div>
        ) : (
          <PriceChartCanvas
            candles={data.candles}
            points={points}
            view={view}
            toDisplay={conv}
            format={(v) => (effCurrency === 'USDT' ? fmtUsdt(v) : fmtPkr(v))}
            yUnit={`${effCurrency} / ${tokenSymbol}`}
          />
        )}
      </div>

      {/* Footer note */}
      {data && data.tradeCount > 0 && (
        <p className="mt-2 text-[11px] text-text-muted">
          {data.tradeCount} completed {data.tradeCount === 1 ? 'trade' : 'trades'} in range
          {data.droppedOutliers > 0 ? ` · ${data.droppedOutliers} outlier ${data.droppedOutliers === 1 ? 'record' : 'records'} skipped` : ''}
          {effCurrency === 'USDT' && usdtAvailable ? ` · converted at 1 USDT ≈ PKR ${fmtPkr(rate as number)}` : ''}
        </p>
      )}
      </>
      )}

      {showCalc && (
        <PriceCalculator
          tokenSymbol={tokenSymbol}
          pricePkr={points.length ? points[points.length - 1].p : null}
          rate={rate}
          onClose={() => setShowCalc(false)}
        />
      )}
    </div>
  )
}

// ─── Compact converter popover ────────────────────────────────────────────────
// Token-scoped: enter an amount in one unit, see the other two, using the latest
// close price (PKR) and the USDT/PKR rate. Mirrors the landing calculator idea
// but focused on this one token.

function PriceCalculator({ tokenSymbol, pricePkr, rate, onClose }: {
  tokenSymbol: string
  pricePkr: number | null
  rate: number | null
  onClose: () => void
}) {
  type Unit = 'TOKEN' | 'USDT' | 'PKR'
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState<Unit>('TOKEN')

  const usdtPerToken = pricePkr !== null && rate ? pricePkr / rate : null
  const amt = parseFloat(amount)
  const valid = !isNaN(amt) && amt >= 0 && pricePkr !== null

  // Resolve everything to a token quantity first, then derive the rest.
  let tokenQty: number | null = null
  if (valid) {
    if (unit === 'TOKEN') tokenQty = amt
    else if (unit === 'PKR') tokenQty = pricePkr ? amt / pricePkr : null
    else tokenQty = usdtPerToken ? amt / usdtPerToken : null // USDT
  }
  const outPkr = tokenQty !== null && pricePkr !== null ? tokenQty * pricePkr : null
  const outUsdt = tokenQty !== null && usdtPerToken !== null ? tokenQty * usdtPerToken : null

  return (
    <div className="absolute right-4 top-16 z-20 w-72 rounded-xl border border-border bg-surface shadow-xl p-4">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-text-secondary">
          <Calculator size={13} /> {tokenSymbol} calculator
        </span>
        <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary"><X size={15} /></button>
      </div>

      {pricePkr === null ? (
        <p className="mt-3 text-xs text-text-muted">No recent price to calculate from. Try a wider timeframe.</p>
      ) : (
        <>
          <div className="mt-3 flex gap-2">
            <input
              type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="flex-1 min-w-0 border border-border rounded-lg px-2.5 py-2 text-sm bg-canvas focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <select
              value={unit} onChange={(e) => setUnit(e.target.value as Unit)}
              className="border border-border rounded-lg px-2 py-2 text-sm bg-canvas focus:outline-none"
            >
              <option value="TOKEN">{tokenSymbol}</option>
              <option value="USDT" disabled={usdtPerToken === null}>USDT</option>
              <option value="PKR">PKR</option>
            </select>
          </div>

          <div className="mt-3 space-y-1.5 text-sm">
            {unit !== 'TOKEN' && (
              <Row label={tokenSymbol} value={tokenQty !== null ? tokenQty.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'} />
            )}
            {unit !== 'USDT' && (
              <Row label="USDT" value={outUsdt !== null ? `$${fmtUsdt(outUsdt)}` : 'rate unavailable'} />
            )}
            {unit !== 'PKR' && (
              <Row label="PKR" value={outPkr !== null ? `PKR ${fmtPkr(outPkr)}` : '—'} />
            )}
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-text-muted">
            <ArrowLeftRight size={11} />
            1 {tokenSymbol} = {usdtPerToken !== null ? `$${fmtUsdt(usdtPerToken)}` : '—'} · PKR {fmtPkr(pricePkr)}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="font-semibold text-text-primary">{value}</span>
    </div>
  )
}
