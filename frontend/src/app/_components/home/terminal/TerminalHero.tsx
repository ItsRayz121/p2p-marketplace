'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, marketplaceApi, type CtmPriceRange, type MarketActivity, type UsdtPriceHistory } from '@/lib/api'
import { PriceChartCanvas, type ChartView } from '@/components/ui/PriceChartCanvas'
import { useTerminal } from './TerminalProvider'
import { changeView, fmtCompact, fmtPkr, fmtPrice } from './format'

const RANGES: { key: CtmPriceRange; label: string }[] = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
]

/** Price headline for the selected market: symbol picker + big last price + 24h move. */
export function TerminalPriceHeadline() {
  const { overview, selected, select, updatedAt } = useTerminal()
  const rows = overview?.rows ?? []
  const row = rows.find((r) => r.slug === selected) ?? rows.find((r) => r.slug === 'usdt')
  const ch = changeView(row?.changePercent24h)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" aria-hidden />
          LIVE
        </span>
        <span aria-hidden>·</span>
        <label className="sr-only" htmlFor="terminal-market">Market</label>
        <select
          id="terminal-market"
          value={row?.slug ?? 'usdt'}
          onChange={(e) => select(e.target.value)}
          className="bg-surface text-text-primary font-semibold border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          {rows.length ? rows.map((r) => <option key={r.slug} value={r.slug}>{r.symbol} / PKR</option>) : <option value="usdt">USDT / PKR</option>}
        </select>
        <span aria-hidden>·</span>
        <span>{row?.kind === 'gas' ? 'LIVE GAS PRICE' : row?.kind === 'ctm' ? 'COMMUNITY TOKEN' : 'P2P MARKET PRICE'}</span>
        {updatedAt && <span className="hidden sm:inline">· updated {updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2">
        <p className="font-mono font-semibold tracking-tight text-5xl sm:text-7xl lg:text-8xl tabular-nums leading-none text-text-primary">
          {fmtPrice(row?.lastPricePkr)}
        </p>
        <div className="pb-1.5 font-mono text-sm">
          <p className="text-text-muted">PKR{row && row.slug !== 'usdt' && row.lastPriceUsdt !== null ? ` · ${fmtPrice(row.lastPriceUsdt)} USDT` : ''}</p>
          <p className={`font-semibold ${ch.cls}`}>{ch.label} <span className="font-normal text-text-muted">24h</span></p>
        </div>
      </div>
    </div>
  )
}

/** Chart card for the selected market, with best bid/ask and spread underneath. */
export function TerminalChartCard() {
  const { overview, selected, history24h, usdtActivity } = useTerminal()
  const row = overview?.rows.find((r) => r.slug === selected)
  const isUsdt = selected === 'usdt'

  const [range, setRange] = useState<CtmPriceRange>('24h')
  const [view, setView] = useState<ChartView>('line')
  const [rangeHistory, setRangeHistory] = useState<UsdtPriceHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [activity, setActivity] = useState<MarketActivity | null>(usdtActivity)

  // USDT history: 24h comes from the server render (kept fresh by the shared
  // poll); other ranges load on demand.
  useEffect(() => {
    if (!isUsdt || range === '24h') return
    let alive = true
    setLoading(true)
    marketplaceApi.getUsdtPriceHistory(range)
      .then((d) => { if (alive) setRangeHistory(d) })
      .catch(() => { if (alive) setRangeHistory(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [isUsdt, range])
  const history = range === '24h' ? history24h : rangeHistory

  // Order-book stats for whichever market is selected.
  useEffect(() => {
    if (isUsdt) { setActivity(usdtActivity); return }
    let alive = true
    setActivity(null)
    api.get<MarketActivity>(`/markets/${encodeURIComponent(selected)}/activity`)
      .then((d) => { if (alive) setActivity(d) })
      .catch(() => { if (alive) setActivity(null) })
    return () => { alive = false }
  }, [isUsdt, selected, usdtActivity])

  useEffect(() => { setRange('24h') }, [selected])

  const bid = activity?.bestBuyPkr ?? row?.buyPricePkr ?? null
  const ask = activity?.bestSellPkr ?? row?.sellPricePkr ?? null
  const spread = bid !== null && ask !== null && ask > 0 ? ((ask - bid) / ask) * 100 : null

  const points = history?.points ?? []
  const candles = history?.candles ?? []
  const spark = row?.sparkline ?? []

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {isUsdt ? (
          <div className="flex gap-1 font-mono text-[11px]" role="tablist" aria-label="Chart range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="tab"
                aria-selected={range === r.key}
                onClick={() => setRange(r.key)}
                className={`px-2 py-1 rounded ${range === r.key ? 'bg-surface-alt text-text-primary font-semibold' : 'text-text-muted hover:text-text-primary'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="font-mono text-[11px] text-text-muted">{spark.length >= 2 ? `LAST ${spark.length} TRADES` : 'PRICE HISTORY'}</p>
        )}
        <div className="flex items-center gap-3 font-mono text-[11px] text-text-muted">
          {activity?.high24hPkr != null && <span>H {fmtPrice(activity.high24hPkr)} · L {fmtPrice(activity.low24hPkr)}</span>}
          {activity?.volume24hUnits != null && <span className="hidden sm:inline">VOL {fmtCompact(activity.volume24hUnits)}</span>}
          {isUsdt && (
            <div className="inline-flex rounded border border-border overflow-hidden">
              {(['line', 'candles'] as ChartView[]).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`px-2 py-0.5 ${view === v ? 'bg-surface-alt text-text-primary font-semibold' : 'hover:text-text-primary'}`}>
                  {v === 'line' ? 'Line' : 'Candles'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 min-h-[240px]">
        {isUsdt ? (
          loading ? (
            <div className="h-[240px] rounded-lg bg-surface-alt animate-pulse" />
          ) : points.length >= 2 ? (
            <PriceChartCanvas
              candles={candles}
              points={points}
              view={view}
              toDisplay={(v) => v}
              format={fmtPkr}
              height={240}
              yUnit="PKR / USDT"
            />
          ) : (
            <ChartEmpty text="Not enough completed trades in this range yet." />
          )
        ) : spark.length >= 2 ? (
          <TradeLine values={spark} />
        ) : (
          <ChartEmpty text={row?.kind === 'gas' ? 'Gas prices are live quotes, so there is no trade history to chart.' : 'No trades yet for this token.'} />
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 divide-x divide-border border-t border-border pt-3 font-mono">
        <div className="pr-3">
          <p className="text-[10px] text-text-muted uppercase">Best bid</p>
          <p className="text-sm font-semibold tabular-nums text-success">{fmtPrice(bid)}</p>
        </div>
        <div className="px-3">
          <p className="text-[10px] text-text-muted uppercase">Best ask</p>
          <p className="text-sm font-semibold tabular-nums text-danger">{fmtPrice(ask)}</p>
        </div>
        <div className="pl-3">
          <p className="text-[10px] text-text-muted uppercase">Spread</p>
          <p className="text-sm font-semibold tabular-nums text-text-primary">{spread !== null && isFinite(spread) ? `${spread.toFixed(2)}%` : '—'}</p>
        </div>
      </div>
      {!isUsdt && row && (
        <Link href={`/markets/${row.slug}`} className="mt-3 inline-block font-mono text-[11px] font-semibold text-primary hover:underline">
          FULL {row.symbol} MARKET →
        </Link>
      )}
    </div>
  )
}

function ChartEmpty({ text }: { text: string }) {
  return (
    <div className="h-[240px] grid place-items-center rounded-lg border border-dashed border-border text-center px-6">
      <p className="text-sm text-text-muted">{text}</p>
    </div>
  )
}

/** Area line over a plain series of recent trade prices (no timestamps). */
function TradeLine({ values }: { values: number[] }) {
  const w = 600, h = 240, padR = 56, padY = 14
  const min = Math.min(...values), max = Math.max(...values)
  const span = max - min || Math.abs(max) || 1
  const x = (i: number) => (i / (values.length - 1)) * (w - padR)
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - padY * 2)
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const up = values[values.length - 1] >= values[0]
  return (
    <div className={`relative h-[240px] ${up ? 'text-success' : 'text-danger'}`}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
        <defs>
          <linearGradient id="terminal-trade-line" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d}L${x(values.length - 1)},${h}L0,${h}Z`} fill="url(#terminal-trade-line)" />
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute right-0 top-2 font-mono text-[10px] text-text-muted">{fmtPrice(max)}</span>
      <span className="absolute right-0 bottom-2 font-mono text-[10px] text-text-muted">{fmtPrice(min)}</span>
    </div>
  )
}
