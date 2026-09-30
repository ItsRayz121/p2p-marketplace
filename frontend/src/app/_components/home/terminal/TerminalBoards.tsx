'use client'

import Link from 'next/link'
import type { MarketplaceAd, MarketRow } from '@/lib/api'
import { Sparkline } from '@/components/ui/Sparkline'
import { traderDisplayName } from '@/lib/traderName'
import { isOpaqueId } from '@/lib/pkPaymentMethods'
import { tradeTimeAgo } from '@/lib/timeAgo'
import { useTerminal } from './TerminalProvider'
import { changeView, fmtCompact, fmtPrice } from './format'

const ONLINE_MS = 15 * 60_000
const KIND_LABEL: Record<MarketRow['kind'], string> = { usdt: 'P2P', ctm: 'TOKEN', gas: 'GAS' }

// ─── Order book (top USDT ads) ────────────────────────────────────────────────

function BookSide({ ads, sellers, mounted }: { ads: MarketplaceAd[]; sellers: boolean; mounted: boolean }) {
  const rows = ads.slice(0, 5)
  const maxOrder = Math.max(1, ...rows.map((a) => Number(a.maxOrder) || 0))
  const tone = sellers ? 'text-success' : 'text-danger'
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <p className="text-sm font-semibold text-text-primary">
          {sellers ? 'Sellers' : 'Buyers'} <span className="font-normal text-text-muted">· you {sellers ? 'buy' : 'sell'}</span>
        </p>
        <span className={`font-mono text-[11px] ${tone}`}>{sellers ? 'ASK' : 'BID'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-xs text-text-muted">No {sellers ? 'sell' : 'buy'} ads right now</p>
      ) : rows.map((ad) => {
        const s = ad.seller
        const stats = s?.tradeStats
        const pct = stats?.completionRate ? `${(parseFloat(stats.completionRate) * 100).toFixed(0)}%` : null
        const online = mounted && s?.lastSeenAt ? Date.now() - new Date(s.lastSeenAt).getTime() < ONLINE_MS : false
        const methods = (ad.paymentMethods ?? []).filter((pm) => pm && !isOpaqueId(pm)).slice(0, 2)
        const depth = Math.round(((Number(ad.maxOrder) || 0) / maxOrder) * 55)
        return (
          <Link
            key={ad.id}
            href={`/marketplace?side=${sellers ? 'buy' : 'sell'}`}
            className="relative grid grid-cols-[1.5fr_1fr_auto] sm:grid-cols-[1.5fr_1fr_1fr_auto] gap-3 items-center px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-alt/60 transition-colors"
          >
            <span className={`absolute inset-y-0 right-0 ${sellers ? 'bg-success/[0.07]' : 'bg-danger/[0.07]'}`} style={{ width: `${depth}%` }} aria-hidden />
            <span className="relative min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-text-primary truncate">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${online ? 'bg-success' : 'bg-border-strong'}`} aria-label={online ? 'Online' : 'Offline'} />
                <span className="truncate">{traderDisplayName({ fullName: s?.fullName, merchantName: s?.merchantName, username: s?.username })}</span>
              </span>
              <span className="block font-mono text-[10px] text-text-muted truncate">
                {[pct, `${stats?.completedTrades ?? 0} trades`, methods.join(', ')].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className={`relative font-mono text-sm font-semibold tabular-nums ${tone}`}>{fmtPrice(Number(ad.price))}</span>
            <span className="relative hidden sm:block font-mono text-[11px] text-text-muted tabular-nums">
              {fmtCompact(Number(ad.minOrder))}–{fmtCompact(Number(ad.maxOrder))}
            </span>
            <span className={`relative font-mono text-[11px] font-bold px-2.5 py-1 rounded text-white ${sellers ? 'bg-success' : 'bg-danger'}`}>
              {sellers ? 'BUY' : 'SELL'}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

export function TerminalOrderBook() {
  const { topAds, mounted } = useTerminal()
  if (!topAds) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">Offers are loading or unavailable right now.</p>
  }
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <BookSide ads={topAds.sells ?? []} sellers mounted={mounted} />
      <BookSide ads={topAds.buys ?? []} sellers={false} mounted={mounted} />
    </div>
  )
}

// ─── Markets board (every market from /markets/overview) ──────────────────────

export function TerminalMarkets() {
  const { overview, select, selected } = useTerminal()
  const rows = overview?.rows ?? []
  if (!rows.length) {
    return <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">Markets are unavailable right now.</p>
  }
  return (
    <div className="relative rounded-xl border border-border bg-surface overflow-x-auto">
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="font-mono text-[10px] uppercase text-text-muted border-b border-border">
            <th className="text-left font-medium px-4 py-2">Market</th>
            <th className="text-left font-medium">Type</th>
            <th className="text-right font-medium">Last (PKR)</th>
            <th className="text-right font-medium">24h</th>
            <th className="font-medium px-3">Trend</th>
            <th className="text-right font-medium">Trades</th>
            <th className="px-4"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ch = changeView(r.changePercent24h)
            return (
              <tr key={r.slug} className={`border-b border-border last:border-0 hover:bg-surface-alt/60 ${selected === r.slug ? 'bg-surface-alt/60' : ''}`}>
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => { select(r.slug); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    className="flex items-center gap-2.5 text-left"
                    aria-label={`Chart ${r.symbol}`}
                  >
                    {r.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- small remote token logos, same as the Markets table
                      <img src={r.logoUrl} alt="" className="w-7 h-7 rounded-full object-cover bg-surface-alt" loading="lazy" />
                    ) : (
                      <span className="w-7 h-7 rounded-full bg-surface-alt grid place-items-center font-mono text-[10px] font-bold text-text-secondary">{r.symbol.slice(0, 2)}</span>
                    )}
                    <span>
                      <span className="block font-semibold text-text-primary">{r.symbol}</span>
                      <span className="block text-xs text-text-muted">{r.name}</span>
                    </span>
                  </button>
                </td>
                <td>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-alt text-text-muted">{KIND_LABEL[r.kind]}</span>
                  {r.lowData && <span className="ml-1 font-mono text-[9px] text-warning">LOW DATA</span>}
                </td>
                <td className="text-right font-mono tabular-nums text-text-primary">{fmtPrice(r.lastPricePkr)}</td>
                <td className={`text-right font-mono text-xs tabular-nums ${ch.cls}`}>{ch.label}</td>
                <td className="px-3">
                  {r.sparkline.length >= 2 ? <Sparkline points={r.sparkline} className="ml-auto w-28 h-7" /> : <span className="block text-center font-mono text-[10px] text-text-muted">live quote</span>}
                </td>
                <td className="text-right font-mono text-xs tabular-nums text-text-muted">{r.totalTrades ?? '—'}</td>
                <td className="px-4 text-right">
                  <Link
                    href={r.kind === 'gas' ? '/gas' : `/markets/${r.slug}`}
                    className="font-mono text-[11px] font-semibold px-2.5 py-1 rounded border border-border text-text-primary hover:bg-surface-alt"
                  >
                    {r.kind === 'gas' ? 'TOP UP' : 'VIEW'}
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tape (recent USDT / CTM / Gas activity) ──────────────────────────────────

const TAPE_TONE = { usdt: 'text-primary', ctm: 'text-warning', gas: 'text-success' } as const

export function TerminalTape({ limit = 14 }: { limit?: number }) {
  const { tape, mounted } = useTerminal()
  if (!tape.length) return <p className="py-6 text-center font-mono text-xs text-text-muted">No recent trades yet.</p>
  return (
    <ul>
      {tape.slice(0, limit).map((t) => (
        <li key={t.id} className="flex items-center gap-2 py-1.5 border-b border-border last:border-0 font-mono text-[11px]">
          <span className={`w-9 shrink-0 ${TAPE_TONE[t.kind]}`}>{t.kind.toUpperCase()}</span>
          <span className="truncate text-text-secondary">
            <span className="font-semibold text-text-primary">{t.who}</span>{' '}
            {t.kind === 'gas' ? 'topped up' : 'bought'}{' '}
            {t.amount.toLocaleString('en-US', { maximumFractionDigits: t.kind === 'gas' ? 4 : 2 })} {t.asset}{t.kind === 'gas' ? ' gas' : ''}
          </span>
          <span className="ml-auto shrink-0 text-text-muted">{mounted ? tradeTimeAgo(t.at, { collapseAfter24h: true }) : ''}</span>
        </li>
      ))}
    </ul>
  )
}
