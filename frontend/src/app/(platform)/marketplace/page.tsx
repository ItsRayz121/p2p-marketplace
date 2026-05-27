'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { ALL_PAYMENT_METHODS, getPaymentMethodColor, PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { EntityLogo } from '@/components/ui/EntityLogo'

const NETWORKS = [
  { value: '', label: 'All Networks' },
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
  { value: 'Aptos', label: 'Aptos' },
]
const PAYMENT_METHODS = ALL_PAYMENT_METHODS
const PAGE_SIZE = 10

interface Filters {
  side: 'buy' | 'sell'
  network: string
  paymentMethod: string
  minAmount: string
  maxAmount: string
}

function AdRow({ ad }: { ad: MarketplaceAd }) {
  const methods = ad.paymentMethods ?? []
  return (
    <div className="bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Seller info */}
        <div className="flex items-center gap-3 sm:w-52">
          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center flex-shrink-0">
            {(ad.seller?.username || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <Link href={`/profile/${encodeURIComponent(ad.seller?.username || '')}`} className="text-sm font-semibold text-text-primary truncate hover:text-primary transition-colors block">
              {ad.seller?.username || 'Anonymous'}
            </Link>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <BadgeChip badge={(ad.seller?.badge ?? 'new') as TraderBadge} />
              {ad.seller?.tradeStats && (
                <span className="text-xs text-text-muted">
                  {ad.seller.tradeStats.totalTrades} trades
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Price */}
        <div className="sm:flex-1">
          <p className="text-xl font-bold text-text-primary">
            PKR {Number(ad.price).toLocaleString()}
          </p>
          <p className="text-xs text-text-muted">per {ad.coin}</p>
          <p className="text-xs text-text-muted mt-0.5">
            <span className="font-medium">{ad.side === 'buy' ? 'Wanted' : 'Available'}:</span>{' '}
            {Number(ad.availableAmount).toFixed(4)} {ad.coin}
          </p>
        </div>

        {/* Limits */}
        <div className="sm:w-40">
          <p className="text-xs text-text-muted">Limit</p>
          <p className="text-sm font-medium text-text-primary">
            {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} PKR
          </p>
        </div>

        {/* Payment methods */}
        <div className="sm:w-40">
          <p className="text-xs text-text-muted mb-1">Payment</p>
          <div className="flex flex-wrap gap-1">
            {methods.slice(0, 3).map((pm) => {
              const isMobile = PK_MOBILE_METHODS.includes(pm)
              return (
                <span key={pm} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(pm)}`}>
                  <EntityLogo
                    type={isMobile ? 'payment_method' : 'bank'}
                    slug={pm}
                    size="xs"
                    className="flex-shrink-0"
                  />
                  {pm}
                </span>
              )
            })}
            {methods.length > 3 && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-surface text-text-secondary">
                +{methods.length - 3}
              </span>
            )}
          </div>
        </div>

        {/* CTA */}
        {parseFloat(ad.availableAmount) > 0 ? (
          <Link href={`/marketplace/listings/${ad.id}`} className="flex-shrink-0">
            <Button size="sm">{ad.side === 'sell' ? `Buy ${ad.coin}` : `Sell ${ad.coin}`}</Button>
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAds = useCallback(async (p = 1, append = false) => {
    try {
      const params: Record<string, string | number | undefined> = {
        type: filters.side === 'buy' ? 'sell' : 'buy', // buyer sees sell ads
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
      setError(err instanceof Error ? err.message : 'Failed to load ads')
    } finally {
      setLoading(false)
      setLoadingMore(false)
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
    const onFocus = () => { fetchAds(1, false) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [fetchAds])

  const handleLoadMore = async () => {
    const nextPage = page + 1
    setPage(nextPage)
    setLoadingMore(true)
    await fetchAds(nextPage, true)
  }

  const clearFilters = () => {
    setFilters({ side: 'buy', network: '', paymentMethod: '', minAmount: '', maxAmount: '' })
  }

  const hasMore = ads.length < total

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Filters */}
      <div className="sticky top-16 z-20 bg-surface pt-2 pb-4">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Side toggle */}
          <div className="flex bg-white border border-border rounded-lg overflow-hidden flex-shrink-0">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setFilters((f) => ({ ...f, side: s })); setPage(1) }}
                title={s === 'buy' ? 'Find sellers' : 'Find buyers'}
                className={`px-4 py-2.5 text-sm font-medium transition-colors leading-tight ${
                  filters.side === s ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
                }`}
              >
                <span className="block">{s === 'buy' ? 'Buy USDT' : 'Sell USDT'}</span>
                <span className={`hidden sm:block text-xs font-normal ${filters.side === s ? 'text-white/75' : 'text-text-muted'}`}>
                  {s === 'buy' ? 'Find sellers' : 'Find buyers'}
                </span>
              </button>
            ))}
          </div>

          {/* Network selector */}
          <select
            value={filters.network}
            onChange={(e) => setFilters((f) => ({ ...f, network: e.target.value }))}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {NETWORKS.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
          </select>

          {/* Payment method */}
          <select
            value={filters.paymentMethod}
            onChange={(e) => setFilters((f) => ({ ...f, paymentMethod: e.target.value }))}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Payment Methods</option>
            {PAYMENT_METHODS.map((pm) => <option key={pm}>{pm}</option>)}
          </select>

          {/* Amount range */}
          <input
            type="number"
            placeholder="Min PKR"
            value={filters.minAmount}
            onChange={(e) => setFilters((f) => ({ ...f, minAmount: e.target.value }))}
            className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="number"
            placeholder="Max PKR"
            value={filters.maxAmount}
            onChange={(e) => setFilters((f) => ({ ...f, maxAmount: e.target.value }))}
            className="w-28 px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          />

          <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-text-primary">
            {filters.side === 'buy' ? 'Buy USDT' : 'Sell USDT'}
            {filters.network ? ` · ${filters.network === 'BEP20' ? 'BNB Chain' : filters.network}` : ''}
          </h1>
          <p className="text-sm text-text-muted">{total} offers</p>
        </div>
      </div>

      {/* Ad list */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <ErrorState title={error} onRetry={() => fetchAds(1, false)} />
      ) : ads.length === 0 ? (
        <div className="py-4">
          {filters.side === 'buy' ? (
            // User wants to buy — no sell ads available
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <p className="text-2xl">📭</p>
              <div>
                <p className="text-base font-semibold text-text-primary">No sellers found</p>
                <p className="text-sm text-text-muted mt-1">No one is selling USDT right now. Try adjusting your filters or check back soon.</p>
              </div>
            </div>
          ) : (
            // User wants to sell — no buy ads (buyers) available
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <p className="text-2xl">📭</p>
              <div>
                <p className="text-base font-semibold text-text-primary">No buyers yet</p>
                <p className="text-sm text-text-muted mt-1">No buy orders match your filters. You can also create a sell listing so buyers find you.</p>
              </div>
              <Link href="/create-ad">
                <Button>Create a Listing</Button>
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {ads.map((ad) => (
            <AdRow key={ad.id} ad={ad} />
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && !loading && (
        <div className="mt-6 text-center">
          <Button variant="secondary" loading={loadingMore} onClick={handleLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
