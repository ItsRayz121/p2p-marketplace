'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ALL_PAYMENT_METHODS, getPaymentMethodColor, PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

const PAYMENT_METHODS = ALL_PAYMENT_METHODS
const TIERS = ['new', 'basic', 'verified', 'elite']

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  availableAmount: string
  minOrderPkr: string
  maxOrderPkr: string
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

function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'xs' }) {
  const full = Math.round(rating)
  return (
    <span className={`text-yellow-400 ${size === 'xs' ? 'text-xs' : 'text-sm'}`} title={`${rating.toFixed(1)} / 5`}>
      {'★'.repeat(full)}{'☆'.repeat(5 - full)}
    </span>
  )
}

const TIER_COLORS: Record<string, string> = {
  new: 'bg-gray-100 text-gray-700',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-purple-100 text-purple-700',
}

export default function BrowseListingsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [side, setSide] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [sortBy, setSortBy] = useState('createdAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const fetchListings = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await ctmApi.getListings({
        side: side || undefined,
        paymentMethod: paymentMethod || undefined,
        tier: tierFilter || undefined,
        sortBy: sortBy || undefined,
        sortDir: sortDir || undefined,
        page,
        limit: 20,
      })
      const data = res as { listings: Listing[]; total: number }
      setListings(data.listings ?? [])
      setTotal(data.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load listings')
    } finally {
      setLoading(false)
    }
  }, [side, paymentMethod, tierFilter, sortBy, sortDir, page])

  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  useEffect(() => {
    const id = setInterval(fetchListings, 30_000)
    return () => clearInterval(id)
  }, [fetchListings])

  const toggleSortDir = () => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Browse Listings</h1>
          <p className="text-text-muted text-sm">{total} listings available</p>
        </div>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors text-center">
          + Create Listing
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select value={side} onChange={(e) => { setSide(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">Buy &amp; Sell</option>
          <option value="buy">Buy listings</option>
          <option value="sell">Sell listings</option>
        </select>

        <select value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All payment methods</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <select value={tierFilter} onChange={(e) => { setTierFilter(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All tiers</option>
          {TIERS.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
        </select>

        <div className="flex items-center gap-1.5">
          <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
            <option value="createdAt">Newest</option>
            <option value="pricePerUnit">Price</option>
            <option value="ctmAvgRating">Rating</option>
            <option value="completedCtmTrades">Trades</option>
          </select>
          <button
            onClick={toggleSortDir}
            className="border border-border rounded-lg px-2.5 py-2 text-sm bg-white hover:bg-surface transition-colors"
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />)}
        </div>
      ) : error ? (
        <div className="text-center py-16">
          <p className="text-danger text-sm mb-3">{error}</p>
          <button onClick={fetchListings} className="text-sm text-primary underline hover:no-underline">Try again</button>
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No listings found.</div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => {
            const rating = parseFloat(l.merchantProfile.ctmAvgRating)
            const trades = l.merchantProfile.completedCtmTrades
            const methods = l.resolvedPaymentMethods?.length
              ? l.resolvedPaymentMethods
              : l.paymentMethods.map((pm) => ({ id: pm, type: 'other', label: pm }))

            return (
              <div key={l.id} className="bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  {/* Token */}
                  <div className="flex items-center gap-3 sm:w-44">
                    <EntityLogo type="token" slug={l.token.symbol} size="lg" logoUrl={l.token.logoUrl} />
                    <div>
                      <p className="font-semibold text-text-primary text-sm">{l.token.name}</p>
                      <p className="text-xs text-text-muted">{l.token.symbol}</p>
                    </div>
                  </div>

                  {/* Price + amount */}
                  <div className="sm:flex-1">
                    <p className="text-xl font-bold text-text-primary">PKR {Number(l.pricePerUnit).toLocaleString()}</p>
                    <p className="text-xs text-text-muted">per {l.token.symbol}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      <span className="font-medium">{l.side === 'buy' ? 'Wanted' : 'Available'}:</span>{' '}
                      {Number(l.availableAmount).toFixed(4)} {l.token.symbol}
                    </p>
                  </div>

                  {/* Limits */}
                  <div className="sm:w-44">
                    <p className="text-xs text-text-muted">Limit</p>
                    <p className="text-sm font-medium text-text-primary">PKR {Number(l.minOrderPkr).toLocaleString()} – {Number(l.maxOrderPkr).toLocaleString()}</p>
                  </div>

                  {/* Merchant */}
                  <div className="sm:w-36">
                    <p className="text-xs text-text-muted mb-0.5">Merchant</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">{l.merchantProfile.user.username}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${TIER_COLORS[l.merchantProfile.tier] ?? 'bg-gray-100 text-gray-700'}`}>
                        {l.merchantProfile.tier}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {rating > 0 ? (
                        <>
                          <StarRating rating={rating} size="xs" />
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
                          <span key={pm.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(pm.label)}`}>
                            <EntityLogo type={PK_MOBILE_METHODS.includes(pm.label) ? 'payment_method' : 'bank'} slug={pm.label} size="xs" className="flex-shrink-0" />
                            {pm.label}
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
                  <Link href={`/ctm/listings/${l.id}`} className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${l.side === 'sell' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                    {l.side === 'sell' ? `Buy ${l.token.symbol}` : `Sell ${l.token.symbol}`}
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2 mt-8">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={listings.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  )
}
