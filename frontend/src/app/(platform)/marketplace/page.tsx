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

const NETWORKS = [
  { value: '', label: 'All Networks' },
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
  { value: 'TRC20', label: 'Tron (TRC20)' },
  { value: 'ERC20', label: 'Ethereum (ERC20)' },
  { value: 'Aptos', label: 'Aptos' },
]
const PAYMENT_METHODS = ALL_PAYMENT_METHODS
const PAGE_SIZE = 20

const BADGE_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-purple-100 text-purple-700',
}

interface Filters {
  side: 'buy' | 'sell'
  network: string
  paymentMethod: string
  minAmount: string
  maxAmount: string
}

function StarRating({ rating }: { rating: number }) {
  const full = Math.round(rating)
  return (
    <span className="text-yellow-400 text-xs" title={`${rating.toFixed(1)} / 5`}>
      {'★'.repeat(full)}{'☆'.repeat(5 - full)}
    </span>
  )
}

function AdRow({ ad }: { ad: MarketplaceAd }) {
  const methods = ad.paymentMethods ?? []
  const rating = parseFloat(ad.seller?.tradeStats?.avgRating ?? '0')
  const trades = ad.seller?.tradeStats?.totalTrades ?? 0

  return (
    <div className="bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">

        {/* USDT logo + coin/network */}
        <div className="flex items-center gap-3 sm:w-44">
          <EntityLogo type="token" slug="USDT" size="lg" />
          <div>
            <p className="font-semibold text-text-primary text-sm">{ad.coin}</p>
            <p className="text-xs text-text-muted">{ad.network}</p>
          </div>
        </div>

        {/* Price + available */}
        <div className="sm:flex-1">
          <p className="text-xl font-bold text-text-primary">PKR {Number(ad.price).toLocaleString()}</p>
          <p className="text-xs text-text-muted">per {ad.coin}</p>
          <p className="text-xs text-text-muted mt-0.5">
            <span className="font-medium">{ad.side === 'buy' ? 'Wanted' : 'Available'}:</span>{' '}
            {Number(ad.availableAmount).toFixed(4)} {ad.coin}
          </p>
        </div>

        {/* Limits */}
        <div className="sm:w-44">
          <p className="text-xs text-text-muted">Limit</p>
          <p className="text-sm font-medium text-text-primary">
            {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} {ad.coin}
          </p>
        </div>

        {/* Seller info */}
        <div className="sm:w-36">
          <p className="text-xs text-text-muted mb-0.5">Seller</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-text-primary">{ad.seller?.username ?? 'Anonymous'}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${BADGE_COLORS[ad.seller?.badge ?? 'new'] ?? 'bg-gray-100 text-gray-700'}`}>
              {ad.seller?.badge ?? 'new'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {rating > 0 ? (
              <>
                <StarRating rating={rating} />
                <span className="text-xs text-text-muted">{rating.toFixed(1)}</span>
              </>
            ) : (
              <span className="text-xs text-text-muted">No ratings yet</span>
            )}
            <span className="text-xs text-text-muted">· {trades} trades</span>
          </div>
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
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-surface text-text-secondary">
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
          <span className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-full bg-surface text-text-muted border border-border">
            Sold Out
          </span>
        )}

      </div>
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

  const hasMore = ads.length < total

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">USDT Marketplace</h1>
          <p className="text-text-muted text-sm">{total} listings available</p>
        </div>
        <Link href="/create-ad" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors text-center">
          + Create Listing
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        {/* Side toggle */}
        <div className="flex bg-white border border-border rounded-lg overflow-hidden flex-shrink-0">
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

        <select
          value={filters.network}
          onChange={(e) => { setFilters((f) => ({ ...f, network: e.target.value })); setPage(1) }}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
        >
          {NETWORKS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
        </select>

        <select
          value={filters.paymentMethod}
          onChange={(e) => { setFilters((f) => ({ ...f, paymentMethod: e.target.value })); setPage(1) }}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
        >
          <option value="">All payment methods</option>
          {PAYMENT_METHODS.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
        </select>

        <input
          type="number"
          placeholder="Min PKR"
          value={filters.minAmount}
          onChange={(e) => setFilters((f) => ({ ...f, minAmount: e.target.value }))}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none"
        />
        <input
          type="number"
          placeholder="Max PKR"
          value={filters.maxAmount}
          onChange={(e) => setFilters((f) => ({ ...f, maxAmount: e.target.value }))}
          className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none"
        />

        <button
          onClick={() => setFilters({ side: 'buy', network: '', paymentMethod: '', minAmount: '', maxAmount: '' })}
          className="border border-border rounded-lg px-3 py-2 text-sm bg-white hover:bg-surface transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Listing cards */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />
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
