'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

const PAYMENT_METHODS = ['JazzCash', 'Easypaisa', 'Bank Transfer', 'SadaPay', 'NayaPay']

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  availableAmount: string
  minOrderPkr: string
  maxOrderPkr: string
  paymentMethods: string[]
  token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string; riskTier: string }
  merchantProfile: { tier: string; totalCtmTrades: number; user: { id: string; username: string } }
}

export default function BrowseListingsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [side, setSide] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [page, setPage] = useState(1)

  const fetchListings = async () => {
    try {
      const res = await ctmApi.getListings({ side: side || undefined, paymentMethod: paymentMethod || undefined, page, limit: 20 })
      const data = res as { listings: Listing[]; total: number }
      setListings(data.listings ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchListings, 30000)

  const tierBadge = (tier: string) => {
    const colors: Record<string, string> = { new: 'bg-gray-100 text-gray-700', basic: 'bg-blue-100 text-blue-700', verified: 'bg-green-100 text-green-700', elite: 'bg-purple-100 text-purple-700' }
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[tier] ?? 'bg-gray-100 text-gray-700'}`}>{tier}</span>
  }

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
          <option value="">Buy & Sell</option>
          <option value="buy">Buy listings</option>
          <option value="sell">Sell listings</option>
        </select>
        <select value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All payment methods</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />)}
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No listings found.</div>
      ) : (
        <div className="space-y-3">
          {listings.map((l) => (
            <div key={l.id} className="bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-3 sm:w-44">
                  {l.token.logoUrl ? (
                    <img src={l.token.logoUrl} alt={l.token.name} className="w-9 h-9 rounded-full object-cover" />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center">{l.token.symbol.charAt(0)}</div>
                  )}
                  <div>
                    <p className="font-semibold text-text-primary text-sm">{l.token.name}</p>
                    <p className="text-xs text-text-muted">{l.token.symbol}</p>
                  </div>
                </div>

                <div className="sm:flex-1">
                  <p className="text-xl font-bold text-text-primary">PKR {Number(l.pricePerUnit).toLocaleString()}</p>
                  <p className="text-xs text-text-muted">per {l.token.symbol}</p>
                </div>

                <div className="sm:w-44">
                  <p className="text-xs text-text-muted">Limit</p>
                  <p className="text-sm font-medium text-text-primary">PKR {Number(l.minOrderPkr).toLocaleString()} – {Number(l.maxOrderPkr).toLocaleString()}</p>
                </div>

                <div className="sm:w-32">
                  <p className="text-xs text-text-muted mb-1">Merchant</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-text-primary">{l.merchantProfile.user.username}</span>
                    {tierBadge(l.merchantProfile.tier)}
                  </div>
                </div>

                <Link href={`/ctm/listings/${l.id}`} className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${l.side === 'sell' ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                  {l.side === 'sell' ? 'Buy' : 'Sell'}
                </Link>
              </div>
            </div>
          ))}
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
