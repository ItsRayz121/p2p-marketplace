'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'
import { ALL_PAYMENT_METHODS, getPaymentMethodColor, isMobileMethod, canonicalPaymentLabel, isOpaqueId } from '@/lib/pkPaymentMethods'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { traderDisplayName } from '@/lib/traderName'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { ChevronDown, ShieldCheck, Clock, CheckCircle2, TrendingUp, Coins } from 'lucide-react'
import type { RecentTrade } from '@/lib/api'
import { toast } from '@/lib/toast'
import { checkAlerts, requestAndNotify } from '@/lib/priceAlerts'

const NETWORKS = [
  { value: '', label: 'All Networks' },
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
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


function formatVolumePKR(pkr: string | null | undefined): string | null {
  if (!pkr) return null
  const n = parseFloat(pkr)
  if (isNaN(n) || n < 10_000) return null
  if (n >= 1_00_00_000) return `₨${(n / 1_00_00_000).toFixed(1)}Cr`
  if (n >= 1_00_000)   return `₨${(n / 1_00_000).toFixed(1)}L`
  return `₨${Math.round(n / 1_000)}K`
}

function responseTimeLabel(mins: number | null | undefined): { text: string; cls: string } | null {
  if (mins == null) return null
  if (mins <  5)  return { text: '⚡ < 5 min',  cls: 'text-success font-semibold' }
  if (mins < 30)  return { text: `⚡ ~${mins}m`, cls: 'text-success' }
  if (mins < 60)  return { text: `⚡ ~${mins}m`, cls: 'text-text-muted' }
  return null   // ≥ 60 min — don't advertise a slow responder
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

function memberSince(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function AdRow({ ad }: { ad: MarketplaceAd }) {
  // Never render opaque internal IDs as payment-method chips.
  const methods = (ad.paymentMethods ?? []).filter((pm) => !isOpaqueId(pm))
  const stats = ad.seller?.tradeStats
  const rating = parseFloat(stats?.avgRating ?? '0')
  const completedTrades = stats?.completedTrades ?? 0
  const completionPct = stats?.completionRate != null ? parseFloat(stats.completionRate) * 100 : null
  const completionColor =
    completionPct === null ? '' :
    completionPct >= 90    ? 'text-success' :
    completionPct >= 70    ? 'text-warning'  : 'text-danger'

  const activity = activeLabel(ad.seller?.lastSeenAt ?? null)
  const responseTime = responseTimeLabel(stats?.avgResponseMinutes)
  const totalReviews = stats?.totalReviews ?? 0
  const isSell     = ad.side === 'sell'
  const userAction = isSell ? 'BUY' : 'SELL'
  const accentCls  = isSell ? 'border-l-emerald-500' : 'border-l-blue-500'
  const chipCls    = isSell ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
  const priceCls   = isSell ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'
  const profileHref = `/profile/${ad.seller?.username}`
  const sellerName = traderDisplayName({
    fullName: ad.seller?.fullName,
    merchantName: ad.seller?.merchantName,
    username: ad.seller?.username,
  })

  return (
    <div className={`bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow border-l-4 ${accentCls}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">

        {/* ── 1. TRADER IDENTITY (first & most prominent) ── */}
        <div className="sm:w-52 flex-shrink-0">
          {/* Avatar + name row */}
          <div className="flex items-center gap-2 mb-1.5">
            <Link href={profileHref} onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
              <UserAvatar name={sellerName} avatarUrl={ad.seller?.avatarUrl} size="sm" />
            </Link>
            <div className="min-w-0">
              <Link
                href={profileHref}
                className="text-sm font-bold text-text-primary hover:text-primary hover:underline block truncate leading-tight"
                onClick={(e) => e.stopPropagation()}
              >
                {sellerName}
              </Link>
              {ad.seller?.joinedAt && (
                <p className="text-[10px] text-text-muted leading-tight">
                  Since {memberSince(ad.seller.joinedAt)}
                </p>
              )}
            </div>
          </div>

          {/* Merchant + Badge + collateral chips */}
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

          {/* Trust metrics: completion · rating (clickable) · trades */}
          <div className="flex items-center gap-2 text-xs flex-wrap">
            {completionPct !== null && (
              <span className={`font-bold ${completionColor}`}>
                {completionPct.toFixed(0)}%
              </span>
            )}
            {rating > 0 ? (
              <Link
                href={`${profileHref}#reviews`}
                className="flex items-center gap-0.5 text-text-muted hover:text-primary transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-gold">★</span>
                {rating.toFixed(1)}
                {totalReviews > 0 && (
                  <span className="text-text-muted/70 ml-0.5">({totalReviews})</span>
                )}
              </Link>
            ) : null}
            <Link
              href={`${profileHref}#trades`}
              className="text-text-muted hover:text-primary transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              {completedTrades} trades
            </Link>
          </div>

          {/* Online status + response time */}
          <div className="flex items-center gap-2 flex-wrap mt-1">
            {activity && (
              <span className={`text-[10px] ${activity.cls}`}>{activity.text}</span>
            )}
            {responseTime && (
              <span className={`text-[10px] ${responseTime.cls}`}>{responseTime.text}</span>
            )}
          </div>
        </div>

        {/* ── 2. COIN + PRICE ── */}
        <div className="sm:flex-1">
          <div className="flex items-center gap-2 mb-1">
            <EntityLogo type="token" slug="USDT" size="md" />
            <div>
              <p className="font-semibold text-text-primary text-sm leading-tight">{ad.coin}</p>
              <p className="text-xs text-text-muted">{ad.network}</p>
            </div>
            <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${chipCls}`}>
              {userAction}
            </span>
          </div>
          <p className={`text-xl font-bold ${priceCls}`}>PKR {Number(ad.price).toLocaleString()}</p>
          <p className="text-xs text-text-muted mt-0.5">
            {ad.side === 'buy' ? 'Wanted' : 'Available'}: {Number(ad.availableAmount).toFixed(4)} {ad.coin}
          </p>
          <p className="text-xs text-text-muted/60 mt-0.5">Listed {listingAge(ad.createdAt)}</p>
        </div>

        {/* ── 3. LIMITS + WINDOW ── */}
        <div className="sm:w-40 flex-shrink-0">
          <p className="text-xs text-text-muted">Order Limit</p>
          <p className="text-sm font-medium text-text-primary">
            {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} {ad.coin}
          </p>
          <p className="text-xs text-text-muted mt-0.5 flex items-center gap-1">
            <Clock size={10} className="flex-shrink-0" />
            {ad.tradeWindow} min window
          </p>
        </div>

        {/* ── 4. PAYMENT METHODS ──
            Column is ALWAYS rendered (fixed width) so that an ad with no payment
            methods leaves this slot blank instead of collapsing the flex row and
            shifting Order Limit / CTA out of alignment with the other rows. */}
        <div className="sm:w-32 flex-shrink-0">
          <p className="text-xs text-text-muted mb-1">Payment</p>
          {methods.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {methods.slice(0, 3).map((pm) => {
                const label = canonicalPaymentLabel(pm)
                return (
                  <span key={pm} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(label)}`}>
                    <EntityLogo type={isMobileMethod(label) ? 'payment_method' : 'bank'} slug={label} size="xs" className="flex-shrink-0" />
                    {label}
                  </span>
                )
              })}
              {methods.length > 3 && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-surface-alt text-text-secondary">
                  +{methods.length - 3}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-text-muted/50">—</span>
          )}
        </div>

        {/* ── 5. CTA ──
            Fixed-width slot (sm:w-36) so the Order-Limit / Payment columns stay
            vertically aligned across cards no matter which CTA variant renders
            ("Buy USDT", "Sold Out" and "Maker unavailable" have different
            intrinsic widths; without a fixed slot they'd shift the flex-1 price
            column and knock the right-hand columns out of line). */}
        <div className="sm:w-36 flex-shrink-0 flex sm:justify-end">
          {ad.makerBondInsufficient ? (
            <span
              className="px-3 py-1.5 text-xs font-semibold rounded-full bg-warning/10 text-warning border border-warning/20 whitespace-nowrap"
              title="This trader's collateral bond is fully committed right now, so new trades can't start. Check back shortly."
            >
              Maker unavailable
            </span>
          ) : parseFloat(ad.availableAmount) > 0 ? (
            <Link
              href={`/marketplace/listings/${ad.id}`}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                ad.side === 'sell' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {ad.side === 'sell' ? `Buy ${ad.coin}` : `Sell ${ad.coin}`}
            </Link>
          ) : (
            <span className="px-3 py-1.5 text-xs font-semibold rounded-full bg-surface-alt text-text-muted border border-border whitespace-nowrap">
              Sold Out
            </span>
          )}
        </div>

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
  // Constant, readable scroll speed regardless of trade count (~6s per trade) —
  // shared with the CTM ticker so both markets scroll at the same pace.
  const marqueeDuration = Math.max(trades.length * 6, 30)
  return (
    <div className="relative bg-surface border border-border rounded-xl overflow-hidden mb-4">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-alt">
        <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Recent Trades</span>
      </div>
      <div className="flex overflow-hidden">
        <div className="flex gap-3 px-3 py-2 whitespace-nowrap" style={{ animation: `marquee ${marqueeDuration}s linear infinite` }}>
          {items.map((t, i) => (
            <span
              key={`${t.id}-${i}`}
              className="inline-flex items-center gap-1.5 text-xs text-text-secondary flex-shrink-0 border-r border-border pr-3 last:border-0"
            >
              <CheckCircle2 size={11} className="text-success flex-shrink-0" />
              <span className="font-semibold text-text-primary">
                {parseFloat(t.amount).toFixed(2)} {t.coin}
              </span>
              <span className="text-text-muted">{t.buyerFullName || t.buyerUsername} ← {t.sellerFullName || t.sellerUsername}</span>
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
  totalTrades: number
  usdtRate: number | null
  rateSource?: 'recent_trades' | 'active_listings' | 'fx_spot' | 'none'
}

const RATE_SOURCE_LABEL: Record<NonNullable<MarketStats['rateSource']>, string> = {
  recent_trades: 'based on recent trades',
  active_listings: 'based on active listings',
  fx_spot: 'spot rate',
  none: '',
}

function MarketplaceStatsStrip({ stats }: { stats: MarketStats }) {
  return (
    // Mobile: 2-col grid so each stat has its icon aligned in a column (the
    // rate row spans full width with its own coin icon, lined up under the
    // active-listings icon). Desktop (sm+): single inline row with dividers.
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4 text-xs text-text-muted sm:flex sm:flex-wrap sm:items-center">
      <span className="flex items-center gap-1">
        <TrendingUp size={11} className="text-primary flex-shrink-0" />
        <span className="font-semibold text-text-primary">{stats.totalListings}</span> active listings
      </span>
      <span className="w-px h-3 bg-border hidden sm:block" />
      <span className="flex items-center gap-1">
        <CheckCircle2 size={11} className="text-success flex-shrink-0" />
        <span className="font-semibold text-success">{stats.totalTrades}</span> trades completed
      </span>
      {stats.usdtRate !== null && (
        <>
          <span className="w-px h-3 bg-border hidden sm:block" />
          {/* Sits in the right column, directly under "trades completed", with
              its coin icon lined up beneath the trades-completed check icon. */}
          <span className="col-start-2 flex flex-wrap items-center gap-x-1 sm:col-auto">
            <Coins size={11} className="text-primary flex-shrink-0" />
            1 USDT = <span className="font-semibold text-text-primary">PKR {stats.usdtRate.toLocaleString()}</span>
            {stats.rateSource && RATE_SOURCE_LABEL[stats.rateSource] && (
              <span className="w-full text-text-muted sm:w-auto sm:ml-1">{RATE_SOURCE_LABEL[stats.rateSource]}</span>
            )}
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

  // Honour ?side=buy|sell from deep links (e.g. homepage Top Offers → View Market)
  useEffect(() => {
    const side = new URLSearchParams(window.location.search).get('side')
    if (side === 'buy' || side === 'sell') {
      setFilters((f) => (f.side === side ? f : { ...f, side }))
    }
  }, [])
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
      if (filters.paymentMethod) params.paymentMethod = filters.paymentMethod
      if (filters.minAmount) params.minAmount = filters.minAmount
      if (filters.maxAmount) params.maxAmount = filters.maxAmount
      const res = await marketplaceApi.getAds(params)
      setAds(res.ads)
      setTotal(res.total)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh listings')
    }
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
        marketplaceApi.getUsdtReferenceRate(),
      ])
      if (tradesRes.status === 'fulfilled') setRecentTrades(tradesRes.value)
      if (statsRes.status === 'fulfilled') {
        const s = statsRes.value as { totalTrades: number; todayTrades?: number }
        const rate = rateRes.status === 'fulfilled' ? rateRes.value.rate : null
        const rateSource = rateRes.status === 'fulfilled' ? rateRes.value.source : undefined
        setMarketStats({
          totalListings: total,
          totalTrades: s.totalTrades ?? 0,
          usdtRate: rate,
          ...(rateSource ? { rateSource } : {}),
        })
        if (rate) {
          // Check price alerts and fire notifications for any that triggered
          const triggered = checkAlerts(rate)
          for (const a of triggered) {
            const msg = `USDT is now PKR ${rate.toLocaleString()} — your ${a.direction} PKR ${a.targetPkr.toLocaleString()} alert triggered.`
            await requestAndNotify('RupChain Price Alert', msg)
            toast.success(`Price alert: USDT ${a.direction === 'above' ? '↑' : '↓'} PKR ${a.targetPkr.toLocaleString()}`, msg)
          }
        }
      }
    } catch { /* stats are non-critical — suppress */ }
  }, [total])

  usePolling(fetchMeta, 60_000, true)

  const hasMore = ads.length < total

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">

      {/* Page header — title on top, full-width Create Listing below on mobile
          (mirrors the CTM market header). Price alerts moved to Settings →
          Notifications. */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-text-primary">USDT Marketplace</h1>
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

      {/* Filters — 2-col grid on phones (no ragged wrap), flex row on sm+ */}
      <div className="grid grid-cols-2 gap-2 mb-6 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
        {/* Side toggle */}
        <div className="col-span-2 flex bg-surface border border-border rounded-lg overflow-hidden sm:flex-shrink-0">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setFilters((f) => ({ ...f, side: s })); setPage(1) }}
              className={`flex-1 sm:flex-none px-4 py-2 text-sm font-medium transition-colors ${
                filters.side === s ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
              }`}
            >
              {s === 'buy' ? 'Buy USDT' : 'Sell USDT'}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-auto">
          <select
            value={filters.network}
            onChange={(e) => { setFilters((f) => ({ ...f, network: e.target.value })); setPage(1) }}
            className="w-full sm:w-auto appearance-none border border-border rounded-lg pl-3 pr-8 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary cursor-pointer"
          >
            {NETWORKS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        </div>

        <div className="relative w-full sm:w-auto">
          <select
            value={filters.paymentMethod}
            onChange={(e) => { setFilters((f) => ({ ...f, paymentMethod: e.target.value })); setPage(1) }}
            className="w-full sm:w-auto appearance-none border border-border rounded-lg pl-3 pr-8 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary cursor-pointer"
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
          className="w-full sm:w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />
        <input
          type="number"
          placeholder="Max PKR"
          value={filters.maxAmount}
          onChange={(e) => setFilters((f) => ({ ...f, maxAmount: e.target.value }))}
          className="w-full sm:w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />

        <button
          onClick={() => setFilters({ side: 'buy', network: '', paymentMethod: '', minAmount: '', maxAmount: '' })}
          className="col-span-2 sm:w-auto border border-border rounded-lg px-3 py-2 text-sm bg-surface hover:bg-surface-alt text-text-secondary hover:text-text-primary transition-colors"
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

      {/* Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center mt-8">
          <Button variant="secondary" onClick={() => { const next = page + 1; setPage(next); fetchAds(next, true) }}>
            Load more listings
          </Button>
        </div>
      )}
      {!hasMore && ads.length > 0 && (
        <p className="text-center text-xs text-text-muted mt-8">All {total} listings loaded.</p>
      )}

    </div>
  )
}
