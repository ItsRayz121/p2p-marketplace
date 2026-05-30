'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import type { RecentTrade } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ALL_PAYMENT_METHODS, getPaymentMethodColor, PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { MerchantProfileModal } from '@/components/ctm/MerchantProfileModal'
import { CheckCircle2, ChevronDown, TrendingUp, LayoutGrid, Sparkles } from 'lucide-react'

const PAYMENT_METHODS = ALL_PAYMENT_METHODS
const PAGE_SIZE = 20

const TIER_COLORS: Record<string, string> = {
  new: 'bg-surface-alt text-text-secondary',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-primary/10 text-primary',
}

interface CtmToken {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl?: string
}

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  availableAmount: string
  minOrderTokens: string
  maxOrderTokens: string
  paymentMethods: string[]
  resolvedPaymentMethods?: { id: string; type: string; label: string }[]
  token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string; riskTier: string }
  merchantProfile: {
    tier: string
    totalCtmTrades: number
    completedCtmTrades: number
    ctmAvgRating: string
    user: { id: string; username: string }
  }
}

interface CtmStats {
  activeListings: number
  todayTrades: number
  totalTokens: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tradeFeedAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

// ─── Stats Strip ─────────────────────────────────────────────────────────────

function CtmStatsStrip({ stats, total }: { stats: CtmStats; total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4 text-xs text-text-muted">
      <span className="flex items-center gap-1">
        <TrendingUp size={11} className="text-primary" />
        <span className="font-semibold text-text-primary">{total}</span> active listings
      </span>
      <span className="w-px h-3 bg-border hidden sm:block" />
      <span className="flex items-center gap-1">
        <CheckCircle2 size={11} className="text-success" />
        <span className="font-semibold text-success">{stats.todayTrades}</span> trades completed today
      </span>
      <span className="w-px h-3 bg-border hidden sm:block" />
      <span className="flex items-center gap-1">
        <LayoutGrid size={11} className="text-primary" />
        <span className="font-semibold text-text-primary">{stats.totalTokens}</span> tokens listed
      </span>
      <span className="w-px h-3 bg-border hidden sm:block" />
      <Link
        href="/ctm/tokens"
        className="flex items-center gap-1 text-primary hover:underline hover:text-primary/80 transition-colors cursor-pointer"
      >
        <Sparkles size={11} />
        <span className="font-medium">Featured Tokens</span>
      </Link>
    </div>
  )
}

// ─── Recent Trades Feed ───────────────────────────────────────────────────────

function RecentTradesFeed({ trades }: { trades: RecentTrade[] }) {
  if (!trades.length) return null
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
                {parseFloat(t.amount).toLocaleString()} {t.coin}
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

// ─── Listing Card ─────────────────────────────────────────────────────────────

function ListingRow({ listing, onViewMerchant }: { listing: Listing; onViewMerchant: (id: string) => void }) {
  const rating = parseFloat(listing.merchantProfile.ctmAvgRating)
  const trades = listing.merchantProfile.completedCtmTrades
  const methods = listing.resolvedPaymentMethods?.length
    ? listing.resolvedPaymentMethods
    : listing.paymentMethods.map((pm) => ({ id: pm, type: 'other', label: pm }))

  const isSell    = listing.side === 'sell'
  const accentCls = isSell ? 'border-l-emerald-500' : 'border-l-blue-500'
  const chipCls   = isSell ? 'bg-emerald-500/10 text-emerald-600' : 'bg-blue-500/10 text-blue-600'
  const priceCls  = isSell ? 'text-emerald-600' : 'text-blue-600'

  return (
    <div className={`bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow border-l-4 ${accentCls}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">

        {/* Token */}
        <div className="flex items-center gap-3 sm:w-44">
          <EntityLogo type="token" slug={listing.token.symbol} size="lg" logoUrl={listing.token.logoUrl} />
          <div>
            <p className="font-semibold text-text-primary text-sm">{listing.token.name}</p>
            <p className="text-xs text-text-muted">{listing.token.symbol}</p>
            <span className={`inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${chipCls}`}>
              {isSell ? 'BUY' : 'SELL'}
            </span>
          </div>
        </div>

        {/* Price + amount */}
        <div className="sm:flex-1">
          <p className={`text-xl font-bold ${priceCls}`}>PKR {Number(listing.pricePerUnit).toLocaleString()}</p>
          <p className="text-xs text-text-muted">per {listing.token.symbol}</p>
          <p className="text-xs text-text-muted mt-0.5">
            <span className="font-medium">{listing.side === 'buy' ? 'Wanted' : 'Available'}:</span>{' '}
            {Number(listing.availableAmount).toLocaleString()} {listing.token.symbol}
          </p>
        </div>

        {/* Order limits */}
        <div className="sm:w-44">
          <p className="text-xs text-text-muted">Order Limit</p>
          <p className="text-sm font-medium text-text-primary">
            {Number(listing.minOrderTokens).toLocaleString()} – {Number(listing.maxOrderTokens).toLocaleString()} {listing.token.symbol}
          </p>
        </div>

        {/* Merchant */}
        <div className="sm:w-40">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span className="text-sm font-medium text-text-primary">{listing.merchantProfile.user.username}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${TIER_COLORS[listing.merchantProfile.tier] ?? 'bg-surface-alt text-text-secondary'}`}>
              {listing.merchantProfile.tier}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onViewMerchant(listing.merchantProfile.user.id)}
            className="flex items-center gap-1 hover:underline cursor-pointer text-left"
          >
            {rating > 0 ? (
              <span className="text-xs text-text-muted">
                <span className="text-yellow-400">★</span> {rating.toFixed(1)} · {trades} trades
              </span>
            ) : (
              <span className="text-xs text-text-muted">{trades} trades</span>
            )}
          </button>
        </div>

        {/* Payment methods */}
        {methods.length > 0 && (
          <div className="sm:w-36">
            <p className="text-xs text-text-muted mb-1">Payment</p>
            <div className="flex flex-wrap gap-1">
              {methods.slice(0, 3).map((pm) => (
                <span key={pm.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(pm.label)}`}>
                  <EntityLogo type={PK_MOBILE_METHODS.includes(pm.label) ? 'payment_method' : 'bank'} slug={pm.label} size="xs" className="flex-shrink-0" />
                  {pm.label}
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
        <Link
          href={`/ctm/listings/${listing.id}`}
          className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
            isSell ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {isSell ? `Buy ${listing.token.symbol}` : `Sell ${listing.token.symbol}`}
        </Link>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CtmHomePage() {
  const [side, setSide] = useState<'buy' | 'sell' | ''>('')
  const [tokenId, setTokenId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [page, setPage] = useState(1)

  const [listings, setListings] = useState<Listing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([])
  const [ctmStats, setCtmStats] = useState<CtmStats | null>(null)
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [profileUserId, setProfileUserId] = useState<string | null>(null)

  const fetchListings = useCallback(async (p = 1, append = false) => {
    try {
      const params: Record<string, string | number | undefined> = { page: p, limit: PAGE_SIZE }
      if (side) params.side = side
      if (tokenId) params.tokenId = tokenId
      if (paymentMethod) params.paymentMethod = paymentMethod
      // PKR filters map to the listing service's minPricePkr/maxPricePkr if supported;
      // the listings endpoint accepts minAmount/maxAmount as price filters
      if (minAmount) params.minAmount = minAmount
      if (maxAmount) params.maxAmount = maxAmount

      const res = await ctmApi.getListings(params)
      const data = res as { listings: Listing[]; total: number }
      setListings((prev) => append ? [...prev, ...data.listings] : data.listings)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load listings')
    } finally {
      setLoading(false)
    }
  }, [side, tokenId, paymentMethod, minAmount, maxAmount])

  useEffect(() => {
    setLoading(true)
    setPage(1)
    fetchListings(1, false)
  }, [fetchListings])

  const pollFn = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page: 1, limit: PAGE_SIZE }
      if (side) params.side = side
      if (tokenId) params.tokenId = tokenId
      if (paymentMethod) params.paymentMethod = paymentMethod
      if (minAmount) params.minAmount = minAmount
      if (maxAmount) params.maxAmount = maxAmount
      const res = await ctmApi.getListings(params)
      const data = res as { listings: Listing[]; total: number }
      setListings(data.listings)
      setTotal(data.total)
    } catch { /* silently fail */ }
  }, [side, tokenId, paymentMethod, minAmount, maxAmount])

  usePolling(pollFn, 30_000, !loading)

  const fetchMeta = useCallback(async () => {
    try {
      const [statsRes, tradesRes, tokensRes] = await Promise.allSettled([
        ctmApi.getStats(),
        ctmApi.getRecentTrades(),
        ctmApi.getTokens({ limit: 50 }),
      ])
      if (statsRes.status === 'fulfilled') setCtmStats(statsRes.value)
      if (tradesRes.status === 'fulfilled') setRecentTrades(tradesRes.value)
      if (tokensRes.status === 'fulfilled') setTokens((tokensRes.value as { tokens: CtmToken[] }).tokens ?? [])
    } catch { /* silently fail */ }
  }, [])

  usePolling(fetchMeta, 60_000, true)

  const clearFilters = () => {
    setSide('')
    setTokenId('')
    setPaymentMethod('')
    setMinAmount('')
    setMaxAmount('')
    setPage(1)
  }

  const hasMore = listings.length < total

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Community Token Market</h1>
          <p className="text-text-muted text-sm">{total} listings available</p>
        </div>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors text-center">
          + Create Listing
        </Link>
      </div>

      {/* Stats strip */}
      {ctmStats && <CtmStatsStrip stats={ctmStats} total={total} />}

      {/* Recent trades ticker */}
      <RecentTradesFeed trades={recentTrades} />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        {/* Buy / Sell toggle */}
        <div className="flex bg-surface border border-border rounded-lg overflow-hidden flex-shrink-0">
          {([
            { value: 'buy' as const, label: 'Buy Tokens' },
            { value: 'sell' as const, label: 'Sell Tokens' },
          ]).map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setSide((s) => s === opt.value ? '' : opt.value); setPage(1) }}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                side === opt.value ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* All Tokens */}
        <div className="relative">
          <select
            value={tokenId}
            onChange={(e) => { setTokenId(e.target.value); setPage(1) }}
            className="appearance-none border border-border rounded-lg pl-3 pr-8 py-2 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary cursor-pointer"
          >
            <option value="">All Tokens</option>
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.symbol})</option>
            ))}
          </select>
          <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        </div>

        {/* Payment methods */}
        <div className="relative">
          <select
            value={paymentMethod}
            onChange={(e) => { setPaymentMethod(e.target.value); setPage(1) }}
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
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />
        <input
          type="number"
          placeholder="Max PKR"
          value={maxAmount}
          onChange={(e) => setMaxAmount(e.target.value)}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-text-primary"
        />

        <button
          onClick={clearFilters}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-surface hover:bg-surface-alt text-text-secondary hover:text-text-primary transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Listings */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-16">
          <p className="text-danger text-sm mb-3">{error}</p>
          <button onClick={() => fetchListings(1, false)} className="text-sm text-primary underline hover:no-underline">Try again</button>
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-text-muted text-sm">No listings found. Try adjusting your filters or check back soon.</p>
          <Link href="/ctm/listings/create" className="mt-4 inline-block bg-primary text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors">
            Create a Listing
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => (
            <ListingRow key={l.id} listing={l} onViewMerchant={setProfileUserId} />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="flex justify-center mt-8">
          <button
            onClick={() => { const next = page + 1; setPage(next); fetchListings(next, true) }}
            className="border border-border rounded-lg px-4 py-2 text-sm bg-surface hover:bg-surface-alt text-text-secondary transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {profileUserId && (
        <MerchantProfileModal userId={profileUserId} onClose={() => setProfileUserId(null)} />
      )}

    </div>
  )
}
