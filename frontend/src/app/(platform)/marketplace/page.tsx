'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'
import { ALL_PAYMENT_METHODS, getPaymentMethodColor, PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { ChevronDown, ShieldCheck, Clock, CheckCircle2, TrendingUp } from 'lucide-react'
import type { RecentTrade } from '@/lib/api'

const NETWORKS = [
  { value: '', label: 'All Networks' },
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
  { value: 'TRC20', label: 'Tron (TRC20)' },
  { value: 'ERC20', label: 'Ethereum (ERC20)' },
  { value: 'Aptos', label: 'Aptos' },
]
const PAYMENT_METHODS = ALL_PAYMENT_METHODS
const PAGE_SIZE = 20

interface Filters {
  side: 'buy' | 'sell'
  network: string
  paymentMethod: string
  minAmount: string
  maxAmount: string
}


function listingAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function activeLabel(lastSeenAt: string | null): { text: string; cls: string } | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - new Date(lastSeenAt).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 10)  return { text: 'Online now',    cls: 'text-success' }
  if (mins < 60)  return { text: `Active ${mins}m ago`, cls: 'text-success' }
  const hrs = Math.floor(mins / 60)
  if (hrs < 6)    return { text: `Active ${hrs}h ago`,  cls: 'text-text-muted' }
  if (hrs < 24)   return { text: 'Active today',        cls: 'text-text-muted' }
  const days = Math.floor(hrs / 24)
  if (days <= 3)  return { text: `Active ${days}d ago`,  cls: 'text-text-muted' }
  return null
}

function AdRow({ ad }: { ad: MarketplaceAd }) {
  const methods = ad.paymentMethods ?? []
  const stats = ad.seller?.tradeStats
  const rating = parseFloat(stats?.avgRating ?? '0')
  const completedTrades = stats?.completedTrades ?? 0
  // API returns completion rate as decimal 0–1; multiply to get percentage
  const completionPct = stats?.completionRate != null ? parseFloat(stats.completionRate) * 100 : null
  const completionColor =
    completionPct === null ? '' :
    completionPct >= 90    ? 'text-success' :
    completionPct >= 70    ? 'text-warning'  : 'text-danger'

  const activity = activeLabel(ad.seller?.lastSeenAt ?? null)
  const isSell     = ad.side === 'sell'
  const userAction = isSell ? 'BUY' : 'SELL'
  const accentCls  = isSell ? 'border-l-emerald-500' : 'border-l-blue-500'
  const chipCls    = isSell ? 'bg-emerald-500/10 text-emerald-600' : 'bg-blue-500/10 text-blue-600'
  const priceCls   = isSell ? 'text-emerald-600' : 'text-blue-600'

  return (
    <div className={`bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow border-l-4 ${accentCls}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">

        {/* USDT logo + coin/network */}
        <div className="flex items-center gap-3 sm:w-44">
          <EntityLogo type="token" slug="USDT" size="lg" />
          <div>
            <p className="font-semibold text-text-primary text-sm">{ad.coin}</p>
            <p className="text-xs text-text-muted">{ad.network}</p>
            <span className={`inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${chipCls}`}>
              {userAction}
            </span>
          </div>
        </div>

        {/* Price + available + listing age */}
        <div className="sm:flex-1">
          <p className={`text-xl font-bold ${priceCls}`}>PKR {Number(ad.price).toLocaleString()}</p>
          <p className="text-xs text-text-muted">per {ad.coin}</p>
          <p className="text-xs text-text-muted mt-0.5">
            <span className="font-medium">{ad.side === 'buy' ? 'Wanted' : 'Available'}:</span>{' '}
            {Number(ad.availableAmount).toFixed(4)} {ad.coin}
          </p>
          <p className="text-xs text-text-muted mt-0.5">Listed {listingAge(ad.createdAt)}</p>
        </div>

        {/* Limits + trade window */}
        <div className="sm:w-44">
          <p className="text-xs text-text-muted">Order Limit</p>
          <p className="text-sm font-medium text-text-primary">
            {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} {ad.coin}
          </p>
          <p className="text-xs text-text-muted mt-0.5 flex items-center gap-1">
            <Clock size={10} className="flex-shrink-0" />
            {ad.tradeWindow} min window
          </p>
        </div>

        {/* Seller trust block */}
        <div className="sm:w-48">
          {/* Name + avatar row */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <UserAvatar name={ad.seller?.username ?? 'A'} size="xs" />
            <Link
              href={`/profile/${ad.seller?.username}`}
              className="text-sm font-semibold text-text-primary hover:text-primary hover:underline truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {ad.seller?.username ?? 'Anonymous'}
            </Link>
          </div>

          {/* Merchant + Badge + collateral row */}
          <div className="flex items-center gap-1 flex-wrap mb-1.5">
            {ad.seller?.isMerchant && ad.seller?.merchantId && (
              <Link
                href={`/merchant/${ad.seller.merchantId}`}
                className="inline-flex items-center gap-0.5 text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full hover:bg-primary/20 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ShieldCheck size={9} />
                Merchant
              </Link>
            )}
            <BadgeChip badge={(ad.seller?.badge ?? 'new') as TraderBadge} />
            {ad.seller?.hasCollateral && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-success bg-success/10 px-1.5 py-0.5 rounded-full">
                <ShieldCheck size={9} />
                Collateral
              </span>
            )}
          </div>

          {/* Stats row: completion · rating · completed trades */}
          <div className="flex items-center gap-2 text-xs flex-wrap">
            {completionPct !== null && (
              <span className={`font-bold ${completionColor}`}>
                {completionPct.toFixed(0)}%
              </span>
            )}
            {rating > 0 && (
              <span className="flex items-center gap-0.5 text-text-muted">
                <span className="text-gold">★</span>
                {rating.toFixed(1)}
              </span>
            )}
            <span className="text-text-muted">{completedTrades} done</span>
          </div>

          {/* Active status */}
          {activity && (
            <p className={`text-[10px] mt-1 ${activity.cls}`}>
              {activity.text}
            </p>
          )}
        </div>

        {/* Payment methods */}
        {methods.length > 0 && (
          <div className="sm:w-36">
            <p className="text-xs text-text-muted mb-1">Payment</p>
            <div className="flex flex-wrap gap-1">
              {methods.slice(0, 3).map((pm) => (
                <span key={pm} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(pm)}`}>
                  <EntityLogo type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'} slug={pm} size="xs" className="flex-shrink-0" />
                  {pm}
                </span>
              ))}
              {methods.length > 3 && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-surface-alt text-text-secondary">
                  +{methods.length - 3}
                </span>
              )}
            </div>
          </div>
        )}

        {/* CTA */}
        {parseFloat(ad.availableAmount) > 0 ? (
          <Link
            href={`/marketplace/listings/${ad.id}`}
            className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              ad.side === 'sell' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {ad.side === 'sell' ? `Buy ${ad.coin}` : `Sell ${ad.coin}`}
          </Link>
        ) : (
          <span className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-full bg-surface-alt text-text-muted border border-border">
            Sold Out
          </span>
        )}

      </div>
    </div>
  )
}

// ─── Recent Trades Feed ───────────────────────────────────────────────────────

function tradeFeedAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

function RecentTradesFeed({ trades }: { trades: RecentTrade[] }) {
  if (!trades.length) return null
  // Duplicate list for seamless infinite scroll
  const items = [...trades, ...trades]
  return (
    <div className="relative bg-surface border border-border rounded-xl overflow-hidden mb-4">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-alt">
        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Recent Trades</span>
      </div>
      <div className="flex overflow-hidden">
        <div className="flex gap-3 px-3 py-2 animate-[marquee_40s_linear_infinite] whitespace-nowrap">
          {items.map((t, i) => (
            <span
              key={`${t.id}-${i}`}
              className="inline-flex items-center gap-1.5 text-xs text-text-secondary flex-shrink-0 border-r border-border pr-3 last:border-0"
            >
              <CheckCircle2 size={11} className="text-success flex-shrink-0" />
              <span className="font-semibold text-text-primary">
                {parseFloat(t.amount).toFixed(2)} {t.coin}
              </span>
              <span className="text-text-muted">{t.buyerUsername} ← {t.sellerUsername}</span>
              <span className="text-text-muted/60">{tradeFeedAge(t.completedAt)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Marketplace Stats Strip ──────────────────────────────────────────────────

interface MarketStats {
  totalListings: number
  todayTrades: number
  usdtRate: number | null
}

function MarketplaceStatsStrip({ stats }: { stats: MarketStats }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-xs text-text-muted">
      <span className="flex items-center gap-1">
        <TrendingUp size={11} className="text-primary" />
        <span className="font-semibold text-text-primary">{stats.totalListings}</span> active listings
      </span>
      <span className="w-px h-3 bg-border hidden sm:block" />
      <span className="flex items-center gap-1">
        <CheckCircle2 size={11} className="text-success" />
        <span className="font-semibold text-success">{stats.todayTrades}</span> trades completed today
      </span>
      {stats.usdtRate !== null && (
        <>
          <span className="w-px h-3 bg-border hidden sm:block" />
          <span>
            1 USDT = <span className="font-semibold text-text-primary">PKR {stats.usdtRate.toLocaleString()}</span>
          </span>
        </>
      )}
    </div>
  )
}

export default function MarketplacePage() {
  const [filters, setFilters] = useState<Filters>({
    side: 'buy',
    network: '',
    paymentMethod: '',
    minAmount: '',
    maxAmount: '',
  })
  const [ads, setAds] = useState<MarketplaceAd[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([])
  const [marketStats, setMarketStats] = useState<MarketStats | null>(null)

  const fetchAds = useCallback(async (p = 1, append = false) => {
    try {
      const params: Record<string, string | number | undefined> = {
        type: filters.side === 'buy' ? 'sell' : 'buy',
        coin: 'USDT',
        page: p,
        limit: PAGE_SIZE,
      }
      if (filters.network) params.network = filters.network
      if (filters.paymentMethod) params.paymentMethod = filters.paymentMethod
      if (filters.minAmount) params.minAmount = filters.minAmount
      if (filters.maxAmount) params.maxAmount = filters.maxAmount

      const res = await marketplaceApi.getAds(params)
      setAds((prev) => (append ? [...prev, ...res.ads] : res.ads))
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load listings')
    } finally {
      setLoading(false)
    }
  }, [filters])

  useEffect(() => {
    setLoading(true)
    setPage(1)
    fetchAds(1, false)
  }, [fetchAds])

  const pollFn = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = {
        type: filters.side === 'buy' ? 'sell' : 'buy',
        coin: 'USDT',
        page: 1,
        limit: PAGE_SIZE,
      }
      if (filters.network) params.network = filters.network
      const res = await marketplaceApi.getAds(params)
      setAds(res.ads)
      setTotal(res.total)
    } catch { /* silently fail */ }
  }, [filters])

  usePolling(pollFn, 30_000, !loading)

  useEffect(() => {
    const onFocus = () => fetchAds(1, false)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchAds])

  // Fetch recent trades and market stats once on mount, then poll every 60s
  const fetchMeta = useCallback(async () => {
    try {
      const [tradesRes, statsRes, rateRes] = await Promise.allSettled([
        marketplaceApi.getRecentTrades(),
        marketplaceApi.getStats(),
        marketplaceApi.getRate('USDT'),
      ])
      if (tradesRes.status === 'fulfilled') setRecentTrades(tradesRes.value)
      if (statsRes.status === 'fulfilled') {
        const s = statsRes.value as { totalTrades: number; todayTrades?: number }
        const rate = rateRes.status === 'fulfilled' ? rateRes.value.rate : null
        setMarketStats({
          totalListings: total,
          todayTrades: s.todayTrades ?? 0,
          usdtRate: rate,
        })
      }
    } catch { /* silently fail */ }
  }, [total])

  usePolling(fetchMeta, 60_000, true)

  const hasMore = ads.length < total

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">USDT Marketplace</h1>
          <p className="text-text-muted text-sm">{total} listings available</p>
        </div>
        <Link href="/create-ad" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors text-center">
          + Create Listing
        </Link>
      </div>

      {/* Stats strip */}
      {marketStats && <MarketplaceStatsStrip stats={{ ...marketStats, totalListings: total }} />}

      {/* Recent trades ticker */}
      <RecentTradesFeed trades={recentTrades} />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        {/* Side toggle */}
        <div className="flex bg-surface border border-border rounded-lg overflow-hidden flex-shrink-0">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setFilters((f) => ({ ...f, side: s })); setPage(1) }}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                filters.side === s ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
              }`}
            >
              {s === 'buy' ? 'Buy USDT' : 'Sell USDT'}
            </button>
          ))}
        </div>

        <div className="relative">
          <select
            value={filters.network}
            onChange={(e) => { setFilters((f) => ({ ...f, network: e.target.value })); setPage(1) }}
            className="appearance-none border border-border rounded-lg pl-3 pr-8 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary cursor-pointer"
          >
            {NETWORKS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        </div>

        <div className="relative">
          <select
            value={filters.paymentMethod}
            onChange={(e) => { setFilters((f) => ({ ...f, paymentMethod: e.target.value })); setPage(1) }}
            className="appearance-none border border-border rounded-lg pl-3 pr-8 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary cursor-pointer"
          >
            <option value="">All payment methods</option>
            {PAYMENT_METHODS.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        </div>

        <input
          type="number"
          placeholder="Min PKR"
          value={filters.minAmount}
          onChange={(e) => setFilters((f) => ({ ...f, minAmount: e.target.value }))}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />
        <input
          type="number"
          placeholder="Max PKR"
          value={filters.maxAmount}
          onChange={(e) => setFilters((f) => ({ ...f, maxAmount: e.target.value }))}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />

        <button
          onClick={() => setFilters({ side: 'buy', network: '', paymentMethod: '', minAmount: '', maxAmount: '' })}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-surface hover:bg-surface-alt text-text-secondary hover:text-text-primary transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Listing cards */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <ErrorState title={error} onRetry={() => fetchAds(1, false)} />
      ) : ads.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-text-muted text-sm">
            {filters.side === 'buy' ? 'No sellers found. Try adjusting your filters or check back soon.' : 'No buyers found. You can create a sell listing so buyers find you.'}
          </p>
          {filters.side === 'sell' && (
            <Link href="/create-ad" className="mt-4 inline-block bg-primary text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors">
              Create a Listing
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {ads.map((ad) => <AdRow key={ad.id} ad={ad} />)}
        </div>
      )}

      {/* Pagination */}
      {hasMore && !loading && (
        <div className="flex justify-center gap-2 mt-8">
          <Button variant="secondary" onClick={() => { const next = page + 1; setPage(next); fetchAds(next, true) }}>
            Load more
          </Button>
        </div>
      )}

      {total > PAGE_SIZE && ads.length >= PAGE_SIZE && (
        <div className="flex justify-center gap-2 mt-4">
          <button onClick={() => { setPage((p) => Math.max(1, p - 1)); fetchAds(Math.max(1, page - 1)) }} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => { setPage((p) => p + 1); fetchAds(page + 1) }} disabled={ads.length < PAGE_SIZE} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

    </div>
  )
}
