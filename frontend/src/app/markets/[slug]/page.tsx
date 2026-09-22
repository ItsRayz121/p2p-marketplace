import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { buildMeta } from '@/lib/metadata'
import { fetchCtmTokenBySlug, fetchMarketsOverview, fetchMarketActivity, type CtmTokenDetail } from '@/lib/marketsFetch'
import type { MarketRow, MarketActivity, MarketTrade } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { Badge } from '@/components/ui/Badge'
import { CtmPriceChart } from '@/components/ctm/CtmPriceChart'
import { MarketInsightWidget } from '@/components/ctm/MarketInsightWidget'
import { MarketplacePriceChart } from '@/components/marketplace/MarketplacePriceChart'
import { RelatedTokens } from '@/components/markets/RelatedTokens'
import { fmtMarketPkr as fmtPkr, fmtMarketUsdt as fmtUsdt } from '@/lib/marketsFmt'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

const RISK_COLORS: Record<string, string> = {
  low: 'bg-green-500/15 text-green-800 dark:text-green-300',
  medium: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300',
  high: 'bg-orange-500/15 text-orange-800 dark:text-orange-300',
  extreme: 'bg-red-500/15 text-red-800 dark:text-red-300',
}

function fmtUnits(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const max = n !== 0 && Math.abs(n) < 1 ? 6 : 2
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

function ChangeChip({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return <span className="text-sm font-medium text-text-muted">—</span>
  const up = pct > 0, down = pct < 0
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-semibold ${
      up ? 'bg-emerald-500/10 text-emerald-600' : down ? 'bg-red-500/10 text-red-500' : 'bg-surface-alt text-text-muted'
    }`}>
      {up ? '▲' : down ? '▼' : '—'} {Math.abs(pct).toFixed(2)}%
    </span>
  )
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const lower = slug.toLowerCase()
  if (lower === 'usdt') {
    return buildMeta(
      'USDT to PKR Price Today — Live Chart',
      'Live USDT/PKR price on RupChain, built from real completed P2P trades — 24h change, buy/sell averages, and the full price chart.',
      '/markets/usdt',
    )
  }
  // Slugs are always stored lowercase (enforced at creation) — normalize here so
  // this matches the case-insensitive lookups below and a mixed-case URL for a
  // real token doesn't 404.
  const token = await fetchCtmTokenBySlug(lower)
  if (token) {
    return buildMeta(
      `${token.symbol} Price in PKR — ${token.name} Live Chart`,
      `Live ${token.symbol} (${token.name}) price in PKR on RupChain, built from real completed P2P trades — 24h change, buy/sell averages, and the full price history chart.`,
      `/markets/${token.slug}`,
    )
  }

  // Not a CTM token or USDT — check the live gas-fee token rows before giving up.
  const overview = await fetchMarketsOverview()
  const gasRow = overview?.rows.find((r) => r.kind === 'gas' && r.slug.toLowerCase() === lower)
  if (gasRow) {
    return buildMeta(
      `${gasRow.symbol} Price in USDT — ${gasRow.name} Live Rate`,
      `Live ${gasRow.symbol} (${gasRow.name}) market price in USDT and PKR on RupChain, sourced from live exchange rates — used for Gas Fee top-ups.`,
      `/markets/${gasRow.slug}`,
    )
  }

  return { title: 'Token not found' }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function MarketTokenPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const lower = slug.toLowerCase()

  const [overview, activity] = await Promise.all([
    fetchMarketsOverview(),
    fetchMarketActivity(lower),
  ])
  const row = overview?.rows.find((r) => r.slug.toLowerCase() === lower) ?? null
  const otherRows = overview?.rows.filter((r) => r.slug.toLowerCase() !== lower) ?? []

  if (lower === 'usdt') {
    return <UsdtDetail row={row} activity={activity} otherRows={otherRows} />
  }

  if (row?.kind === 'gas') {
    return <GasDetail row={row} activity={activity} otherRows={otherRows} />
  }

  // Same normalization as generateMetadata above — keeps this in sync with the
  // already-lowercased activity/row lookups so a mixed-case URL doesn't 404 a
  // token that actually exists.
  const token = await fetchCtmTokenBySlug(lower)
  if (!token) notFound()
  return <CtmDetail token={token} row={row} activity={activity} otherRows={otherRows} />
}

// ─── Breadcrumb + JSON-LD helper ──────────────────────────────────────────────

function Breadcrumb({ label }: { label: string }) {
  return (
    <nav className="text-xs text-text-muted mb-3">
      <Link href="/" className="hover:text-primary">Home</Link>
      <span className="mx-1.5">/</span>
      <Link href="/markets" className="hover:text-primary">Markets</Link>
      <span className="mx-1.5">/</span>
      <span className="text-text-primary">{label}</span>
    </nav>
  )
}

function buildJsonLd(opts: { name: string; symbol: string; url: string; pricePkr: number | null; description: string }) {
  const ld: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
        { '@type': 'ListItem', position: 2, name: 'Markets', item: `${BASE_URL}/markets` },
        { '@type': 'ListItem', position: 3, name: opts.symbol, item: opts.url },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: `${opts.name} (${opts.symbol})`,
      description: opts.description,
      url: opts.url,
      ...(opts.pricePkr !== null ? {
        offers: { '@type': 'Offer', priceCurrency: 'PKR', price: opts.pricePkr, url: opts.url, availability: 'https://schema.org/InStock' },
      } : {}),
    },
  ]
  return ld
}

// ─── Market Activity + Recent Trades ──────────────────────────────────────────

function MarketActivityCard({ activity, unit }: { activity: MarketActivity | null; unit: string }) {
  if (!activity) return null
  const hasAny = activity.buyOffers > 0 || activity.sellOffers > 0 || activity.volume24hUnits !== null

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        <h2 className="text-sm font-bold text-text-primary">Market Activity</h2>
      </div>

      {!hasAny ? (
        <p className="text-xs text-text-muted">No active listings or trades yet for {unit}.</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <ActivityStat label="Buy Offers" value={`${activity.buyOffers} active`} tone="up" />
          <ActivityStat label="Sell Offers" value={`${activity.sellOffers} active`} tone="down" />

          <ActivityStat label="Best Buy" value={activity.bestBuyPkr !== null ? `PKR ${fmtPkr(activity.bestBuyPkr)}` : '—'} tone="up" />
          <ActivityStat label="Best Sell" value={activity.bestSellPkr !== null ? `PKR ${fmtPkr(activity.bestSellPkr)}` : '—'} tone="down" />

          <ActivityStat label="Available" value={activity.availableBuy !== null ? `${fmtUnits(activity.availableBuy)} ${unit}` : '—'} />
          <ActivityStat label="Available" value={activity.availableSell !== null ? `${fmtUnits(activity.availableSell)} ${unit}` : '—'} />

          <ActivityStat label="24H High" value={activity.high24hPkr !== null ? `PKR ${fmtPkr(activity.high24hPkr)}` : '—'} />
          <ActivityStat label="24H Low" value={activity.low24hPkr !== null ? `PKR ${fmtPkr(activity.low24hPkr)}` : '—'} />

          <div className="col-span-2">
            <ActivityStat label="24H Volume" value={activity.volume24hUnits !== null ? `${fmtUnits(activity.volume24hUnits)} ${unit}` : '—'} />
          </div>
        </div>
      )}
    </div>
  )
}

function ActivityStat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={`font-semibold tabular-nums ${tone === 'up' ? 'text-emerald-600' : tone === 'down' ? 'text-red-500' : 'text-text-primary'}`}>
        {value}
      </p>
    </div>
  )
}

function RecentTradesCard({ activity, unit }: { activity: MarketActivity | null; unit: string }) {
  if (!activity || activity.recentTrades.length === 0) return null
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-bold text-text-primary mb-3">Recent Trades</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted">
              <th className="text-left font-medium pb-2">Time</th>
              <th className="text-right font-medium pb-2">Amount</th>
              <th className="text-right font-medium pb-2">Price (PKR)</th>
              <th className="text-right font-medium pb-2">Side</th>
            </tr>
          </thead>
          <tbody>
            {activity.recentTrades.map((t: MarketTrade, i: number) => (
              <tr key={i} className="border-t border-border/60">
                <td className="py-1.5 text-text-muted tabular-nums">
                  {new Date(t.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </td>
                <td className="py-1.5 text-right tabular-nums text-text-primary">{fmtUnits(t.amount)} {unit}</td>
                <td className="py-1.5 text-right tabular-nums text-text-primary">{fmtPkr(t.pricePkr)}</td>
                <td className={`py-1.5 text-right font-semibold ${t.side === 'buy' ? 'text-emerald-600' : 'text-red-500'}`}>
                  {t.side === 'buy' ? 'Buy' : 'Sell'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── CTM token detail ─────────────────────────────────────────────────────────

function CtmDetail({ token, row, activity, otherRows }: {
  token: CtmTokenDetail; row: MarketRow | null; activity: MarketActivity | null; otherRows: MarketRow[]
}) {
  const url = `${BASE_URL}/markets/${token.slug}`
  const jsonLd = buildJsonLd({ name: token.name, symbol: token.symbol, url, pricePkr: row?.lastPricePkr ?? null, description: token.description })

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Breadcrumb label={token.symbol} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-6">
        <div className="min-w-0 space-y-6">
          {/* Header */}
          <div className="bg-surface shadow-card border border-border rounded-xl p-6">
            <div className="flex items-start gap-4">
              <EntityLogo type="token" slug={token.symbol} logoUrl={token.logoUrl} size="2xl" />
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold text-text-primary">{token.name} <span className="text-text-muted font-medium">({token.symbol})</span></h1>
                <div className="flex items-center gap-2 flex-wrap mt-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${RISK_COLORS[token.riskTier] ?? 'bg-surface-alt text-text-secondary'}`}>
                    {token.riskTier} risk
                  </span>
                  <Badge variant="default" size="sm">{token.settlementType}</Badge>
                  {token.network && <Badge variant="default" size="sm">{token.network}</Badge>}
                </div>
              </div>
            </div>

            <p className="text-sm text-text-muted mt-4">{token.description}</p>

            {(token.officialWebsite || token.officialTwitter || token.officialTelegram) && (
              <div className="flex gap-3 mt-4 flex-wrap">
                {token.officialWebsite && <a href={token.officialWebsite} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Website ↗</a>}
                {token.officialTwitter && <a href={token.officialTwitter} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Twitter ↗</a>}
                {token.officialTelegram && <a href={token.officialTelegram} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Telegram ↗</a>}
              </div>
            )}
          </div>

          {/* Price header — server-rendered so search engines see real numbers immediately */}
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-3xl font-bold text-text-primary tabular-nums">${fmtUsdt(row?.lastPriceUsdt ?? null)}</span>
                <ChangeChip pct={row?.changePercent24h ?? null} />
              </div>
              <p className="text-sm text-text-muted tabular-nums mt-0.5">≈ PKR {fmtPkr(row?.lastPricePkr ?? null)} · per {token.symbol} · 24h</p>
            </div>
          </div>

          <MarketInsightWidget tokenId={token.id} tokenSymbol={token.symbol} side="sell" />

          <div className="grid grid-cols-3 gap-4">
            <StatCard label="Total Trades" value={token.totalTrades.toLocaleString()} />
            <StatCard label="Volume (PKR)" value={`PKR ${Number(token.totalVolumePkr).toLocaleString()}`} />
            <StatCard label="Active Listings" value={(token._count?.listings ?? 0).toString()} href={`/ctm/listings?tokenId=${token.id}`} />
          </div>

          <div className="flex gap-3 flex-wrap">
            <Link href={`/ctm/listings?tokenId=${token.id}&side=sell`}>
              <button className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">Browse Sell Listings</button>
            </Link>
            <Link href={`/ctm/listings?tokenId=${token.id}&side=buy`}>
              <button className="border border-primary text-primary px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors">Browse Buy Listings</button>
            </Link>
          </div>

          <CtmPriceChart tokenId={token.id} tokenSymbol={token.symbol} />

          <MarketActivityCard activity={activity} unit={token.symbol} />
          <RecentTradesCard activity={activity} unit={token.symbol} />

          <Link href="/markets" className="inline-block text-sm text-primary hover:underline">← All markets</Link>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <RelatedTokens rows={otherRows} />
        </aside>
      </div>
    </div>
  )
}

function StatCard({ label, value, href }: { label: string; value: string; href?: string }) {
  if (href) {
    return (
      <Link href={href} className="bg-surface shadow-card border border-border rounded-xl p-4 text-center block hover:border-primary hover:bg-primary/5 transition-colors group">
        <p className="text-xl font-bold text-text-primary group-hover:text-primary">{value}</p>
        <p className="text-xs text-text-muted group-hover:text-primary/80">{label} →</p>
      </Link>
    )
  }
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4 text-center">
      <p className="text-xl font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  )
}

// ─── USDT detail ──────────────────────────────────────────────────────────────

function UsdtDetail({ row, activity, otherRows }: { row: MarketRow | null; activity: MarketActivity | null; otherRows: MarketRow[] }) {
  const url = `${BASE_URL}/markets/usdt`
  const jsonLd = buildJsonLd({
    name: 'Tether USD', symbol: 'USDT', url, pricePkr: row?.lastPricePkr ?? null,
    description: 'Live USDT to PKR price on RupChain, built from real completed P2P trades on the platform.',
  })

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Breadcrumb label="USDT" />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-6">
        <div className="min-w-0 space-y-6">
          <div className="bg-surface shadow-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-4">
              <EntityLogo type="token" slug="usdt" size="2xl" />
              <div>
                <h1 className="text-2xl font-bold text-text-primary">Tether USD <span className="text-text-muted font-medium">(USDT)</span></h1>
                <p className="text-sm text-text-muted">The world&apos;s most-traded stablecoin, pegged 1:1 to the US Dollar.</p>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-3xl font-bold text-text-primary tabular-nums">$1.00</span>
              <ChangeChip pct={row?.changePercent24h ?? null} />
            </div>
            <p className="text-sm text-text-muted tabular-nums mt-0.5">≈ PKR {fmtPkr(row?.lastPricePkr ?? null)} · per USDT · 24h</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <StatCard label="Buy avg (PKR)" value={row?.buyPricePkr !== null && row?.buyPricePkr !== undefined ? fmtPkr(row.buyPricePkr) : '—'} />
            <StatCard label="Sell avg (PKR)" value={row?.sellPricePkr !== null && row?.sellPricePkr !== undefined ? fmtPkr(row.sellPricePkr) : '—'} />
          </div>

          <div className="flex gap-3 flex-wrap">
            <Link href="/marketplace?side=sell">
              <button className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">Buy USDT</button>
            </Link>
            <Link href="/marketplace?side=buy">
              <button className="border border-primary text-primary px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors">Sell USDT</button>
            </Link>
          </div>

          <MarketplacePriceChart />

          <MarketActivityCard activity={activity} unit="USDT" />
          <RecentTradesCard activity={activity} unit="USDT" />

          <Link href="/markets" className="inline-block text-sm text-primary hover:underline">← All markets</Link>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <RelatedTokens rows={otherRows} />
        </aside>
      </div>
    </div>
  )
}

// ─── Gas-fee token detail ──────────────────────────────────────────────────────
// Native tokens sold on the Gas Fee product (BNB, TRX, SOL, TON, SUI, APT, ETH, ...).
// Unlike USDT/CTM these aren't traded P2P here — the price is the same live
// external market rate that drives Gas Fee checkout — so there's no order book
// or trade tape to show; MarketActivityCard/RecentTradesCard render their own
// "no data yet" states when passed an all-null/empty activity object.

function GasDetail({ row, activity, otherRows }: { row: MarketRow | null; activity: MarketActivity | null; otherRows: MarketRow[] }) {
  const symbol = row?.symbol ?? ''
  const name = row?.name ?? symbol
  const url = `${BASE_URL}/markets/${row?.slug ?? symbol.toLowerCase()}`
  const jsonLd = buildJsonLd({
    name, symbol, url, pricePkr: row?.lastPricePkr ?? null,
    description: `Live ${symbol} market price on RupChain, sourced from live exchange rates and used to price Gas Fee top-ups.`,
  })

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Breadcrumb label={symbol} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-6">
        <div className="min-w-0 space-y-6">
          <div className="bg-surface shadow-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-4">
              <EntityLogo type="token" slug={symbol} logoUrl={row?.logoUrl ?? null} size="2xl" />
              <div>
                <h1 className="text-2xl font-bold text-text-primary">{name} <span className="text-text-muted font-medium">({symbol})</span></h1>
                <p className="text-sm text-text-muted">Live market rate — used to price Gas Fee top-ups on RupChain.</p>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-3xl font-bold text-text-primary tabular-nums">${fmtUsdt(row?.lastPriceUsdt ?? null)}</span>
              <ChangeChip pct={row?.changePercent24h ?? null} />
            </div>
            <p className="text-sm text-text-muted tabular-nums mt-0.5">≈ PKR {fmtPkr(row?.lastPricePkr ?? null)} · per {symbol} · live rate</p>
          </div>

          <div className="flex gap-3 flex-wrap">
            <Link href="/gas">
              <button className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">Buy {symbol} (Gas Fee)</button>
            </Link>
          </div>

          <MarketActivityCard activity={activity} unit={symbol} />
          <RecentTradesCard activity={activity} unit={symbol} />

          <Link href="/markets" className="inline-block text-sm text-primary hover:underline">← All markets</Link>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <RelatedTokens rows={otherRows} />
        </aside>
      </div>
    </div>
  )
}
