'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, SlidersHorizontal } from 'lucide-react'
import type { MarketRow } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { fmtMarketPkr as fmtPkr } from '@/lib/marketsFmt'

// Compact "other tokens" browser shown on a token detail page — mirrors the
// tabbed Tokens list from the reference design. Tabs are data-driven off the
// same overview rows the list page uses, so a newly approved CTM token shows
// up here automatically. A "Gas" tab drops in cleanly once Gas Fee tokens join
// the Markets data model (phase 2) — no structural change needed here.

type Tab = 'top' | 'ctm' | 'usdt'
const TABS: { key: Tab; label: string }[] = [
  { key: 'top', label: 'Top Gainers' },
  { key: 'ctm', label: 'CTM' },
  { key: 'usdt', label: 'USDT' },
]

export function RelatedTokens({ rows }: { rows: MarketRow[] }) {
  const [tab, setTab] = useState<Tab>('top')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    let list = rows
    if (tab === 'ctm') list = list.filter((r) => r.kind === 'ctm')
    else if (tab === 'usdt') list = list.filter((r) => r.kind === 'usdt')
    else list = [...list].sort((a, b) => (b.changePercent24h ?? -Infinity) - (a.changePercent24h ?? -Infinity))

    const q = query.trim().toLowerCase()
    if (q) list = list.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
    return list.slice(0, 8)
  }, [rows, tab, query])

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-text-primary">Tokens</h2>
        <div className="flex items-center gap-1 text-text-muted">
          <Search size={14} aria-hidden />
          <SlidersHorizontal size={14} aria-hidden />
        </div>
      </div>

      <div className="relative mb-3">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="w-full rounded-lg border border-border bg-canvas pl-7 pr-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      <div className="flex gap-1 mb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
              tab === t.key ? 'bg-primary text-white' : 'bg-surface-alt text-text-secondary hover:bg-surface-alt/70'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        <span>Token</span>
        <span>Price (PKR) · 24h</span>
      </div>

      <div className="space-y-0.5">
        {filtered.map((r) => (
          <Link
            key={r.slug}
            href={`/markets/${r.slug}`}
            className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-2 hover:bg-surface-alt transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <EntityLogo type="token" slug={r.symbol} logoUrl={r.logoUrl} size="sm" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-text-primary truncate">{r.symbol}</p>
                <p className="text-[10px] text-text-muted truncate">{r.name}</p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-semibold text-text-primary tabular-nums">{fmtPkr(r.lastPricePkr)}</p>
              <p className={`text-[10px] font-medium tabular-nums ${
                r.changePercent24h === null || r.changePercent24h === undefined ? 'text-text-muted'
                  : r.changePercent24h > 0 ? 'text-emerald-600'
                  : r.changePercent24h < 0 ? 'text-red-500' : 'text-text-muted'
              }`}>
                {r.changePercent24h === null || r.changePercent24h === undefined ? '—' : `${r.changePercent24h > 0 ? '+' : ''}${r.changePercent24h.toFixed(2)}%`}
              </p>
            </div>
          </Link>
        ))}
        {filtered.length === 0 && (
          <p className="px-1.5 py-3 text-xs text-text-muted">No other tokens match.</p>
        )}
      </div>
    </div>
  )
}
