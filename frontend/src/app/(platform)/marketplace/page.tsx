'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'

const COINS = ['USDT', 'BTC', 'ETH', 'BNB', 'TRX']
const PAYMENT_METHODS = ['JazzCash', 'Easypaisa', 'Bank Transfer', 'SadaPay', 'NayaPay']
const PAGE_SIZE = 10

interface Filters {
  side: 'buy' | 'sell'
  coin: string
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
        <div className="flex items-center gap-3 sm:w-48">
          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary text-sm font-bold flex items-center justify-center flex-shrink-0">
            {(ad.seller?.username || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary truncate">
              {ad.seller?.username || 'Anonymous'}
            </p>
          </div>
        </div>

        {/* Price */}
        <div className="sm:flex-1">
          <p className="text-xl font-bold text-text-primary">
            PKR {Number(ad.price).toLocaleString()}
          </p>
          <p className="text-xs text-text-muted">per {ad.coin}</p>
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
            {methods.slice(0, 2).map((pm) => (
              <Badge key={pm} variant="default" size="sm">{pm}</Badge>
            ))}
            {methods.length > 2 && (
              <Badge variant="default" size="sm">+{methods.length - 2}</Badge>
            )}
          </div>
        </div>

        {/* CTA */}
        <Link href={`/trade/new?adId=${ad.id}`} className="flex-shrink-0">
          <Button size="sm">Trade</Button>
        </Link>
      </div>
    </div>
  )
}

export default function MarketplacePage() {
  const [filters, setFilters] = useState<Filters>({
    side: 'buy',
    coin: 'USDT',
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
        type: filters.side === 'buy' ? 'sell' : 'buy', // buyer wants sell ads
        coin: filters.coin,
        page: p,
        limit: PAGE_SIZE,
      }
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

  // Reset on filter change
  useEffect(() => {
    setLoading(true)
    setPage(1)
    fetchAds(1, false)
  }, [fetchAds])

  // Poll every 30s
  const pollFn = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = {
        type: filters.side === 'buy' ? 'sell' : 'buy',
        coin: filters.coin,
        page: 1,
        limit: PAGE_SIZE,
      }
      const res = await marketplaceApi.getAds(params)
      setAds(res.ads)
      setTotal(res.total)
    } catch { /* silently fail */ }
  }, [filters])

  usePolling(pollFn, 30_000, !loading)

  // Refresh on focus
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
    setFilters({ side: 'buy', coin: 'USDT', paymentMethod: '', minAmount: '', maxAmount: '' })
  }

  const hasMore = ads.length < total

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6">
      {/* Filters */}
      <div className="sticky top-16 z-20 bg-surface pt-2 pb-4">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Side toggle */}
          <div className="flex bg-white border border-border rounded-lg overflow-hidden flex-shrink-0">
            {(['buy', 'sell'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilters((f) => ({ ...f, side: s }))}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  filters.side === s ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
                }`}
              >
                {s === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>

          {/* Coin selector */}
          <select
            value={filters.coin}
            onChange={(e) => setFilters((f) => ({ ...f, coin: e.target.value }))}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {COINS.map((c) => <option key={c}>{c}</option>)}
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
            {filters.side === 'buy' ? 'Buy' : 'Sell'} {filters.coin}
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
        <EmptyState title="No offers found" description="Try adjusting your filters" />
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
