'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { marketsApi, type MarketRow, type MarketsOverview } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Sparkline } from '@/components/ui/Sparkline'
import { fmtMarketPkr as fmtPkr, fmtMarketUsdt as fmtUsdt } from '@/lib/marketsFmt'

// Live-updating market list. Renders the server-fetched snapshot immediately
// (so Google and first paint see real prices), then polls the same endpoint
// client-side so prices/changes/sparklines refresh without a reload — the
// backend's own 45s Redis cache is the real rate limit, this just re-reads it.
const POLL_MS = 45_000

function ChangeChip({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) {
    return <span className="text-xs font-medium text-text-muted">—</span>
  }
  const up = pct > 0, down = pct < 0
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold ${
      up ? 'bg-emerald-500/10 text-emerald-600' : down ? 'bg-red-500/10 text-red-500' : 'bg-surface-alt text-text-muted'
    }`}>
      {up ? '▲' : down ? '▼' : '—'} {Math.abs(pct).toFixed(2)}%
    </span>
  )
}

export function MarketsTable({ initial }: { initial: MarketsOverview }) {
  const [overview, setOverview] = useState<MarketsOverview>(initial)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    const tick = () => {
      marketsApi.getOverview()
        .then((d) => { if (alive) setOverview(d) })
        .catch(() => { /* keep showing the last good snapshot */ })
    }
    const id = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return overview.rows
    return overview.rows.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
  }, [overview.rows, query])

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search token or symbol"
            className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <p className="hidden sm:block text-xs text-text-muted whitespace-nowrap">
          Updated {new Date(overview.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>

      {/* Column headers — desktop only, cards carry their own labels on mobile */}
      <div className="hidden md:grid grid-cols-[1.6fr_1fr_0.9fr_0.9fr_1fr] gap-3 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span>Token</span>
        <span className="text-right">Last price</span>
        <span className="text-right">24h change</span>
        <span className="text-right">Buy / Sell avg</span>
        <span className="text-right">Trend</span>
      </div>

      <div className="space-y-2">
        {rows.map((row) => <MarketRowCard key={row.slug} row={row} />)}
        {rows.length === 0 && (
          <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-text-muted">
            No tokens match “{query}”.
          </div>
        )}
      </div>
    </div>
  )
}

function MarketRowCard({ row }: { row: MarketRow }) {
  return (
    <Link
      href={`/markets/${row.slug}`}
      className="block rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-primary/40 hover:bg-primary/5 md:grid md:grid-cols-[1.6fr_1fr_0.9fr_0.9fr_1fr] md:items-center md:gap-3"
    >
      {/* Token identity */}
      <div className="flex items-center gap-2.5 min-w-0">
        <EntityLogo type="token" slug={row.symbol} logoUrl={row.logoUrl} size="lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-text-primary">{row.symbol}</span>
            {row.lowData && (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300">Low data</span>
            )}
          </div>
          <p className="truncate text-xs text-text-muted">{row.name}</p>
        </div>
      </div>

      {/* Mobile: price + change inline under the identity row */}
      <div className="mt-2.5 flex items-center justify-between md:hidden">
        <div>
          <div className="font-bold text-text-primary tabular-nums">${fmtUsdt(row.lastPriceUsdt)}</div>
          <div className="text-xs text-text-muted tabular-nums">PKR {fmtPkr(row.lastPricePkr)}</div>
        </div>
        <ChangeChip pct={row.changePercent24h} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-text-muted md:hidden">
        <span>Buy {row.buyPricePkr !== null ? fmtPkr(row.buyPricePkr) : '—'} · Sell {row.sellPricePkr !== null ? fmtPkr(row.sellPricePkr) : '—'}</span>
        {row.sparkline.length >= 2 && <Sparkline points={row.sparkline} className="h-6 w-16" />}
      </div>

      {/* Desktop columns */}
      <span className="hidden md:block text-right tabular-nums">
        <span className="block font-bold text-text-primary">${fmtUsdt(row.lastPriceUsdt)}</span>
        <span className="block text-xs text-text-muted">PKR {fmtPkr(row.lastPricePkr)}</span>
      </span>
      <span className="hidden md:flex justify-end"><ChangeChip pct={row.changePercent24h} /></span>
      <span className="hidden md:block text-right text-xs text-text-muted tabular-nums">
        <span className="text-emerald-600">{row.buyPricePkr !== null ? fmtPkr(row.buyPricePkr) : '—'}</span>
        {' / '}
        <span className="text-blue-600 dark:text-blue-400">{row.sellPricePkr !== null ? fmtPkr(row.sellPricePkr) : '—'}</span>
      </span>
      <span className="hidden md:flex justify-end">
        {row.sparkline.length >= 2 ? <Sparkline points={row.sparkline} className="h-7 w-24" /> : <span className="text-xs text-text-muted">—</span>}
      </span>
    </Link>
  )
}
