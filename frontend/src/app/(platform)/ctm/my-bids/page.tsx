'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ctmApi, ApiError } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface ListingBid {
  id: string
  listingId: string
  pricePerUnit: string
  tokenAmount: string
  fiatAmount: string
  message?: string
  status: string
  expiresAt: string
  createdAt: string
  listing: {
    side: string
    token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string }
    merchantProfile: { user: { id: string; username: string } }
  }
  trade?: { tradeRef: string; status: string } | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-surface-alt text-text-muted',
  cancelled: 'bg-surface-alt text-text-muted',
}

export default function MyBidsPage() {
  const router = useRouter()
  const [bids, setBids] = useState<ListingBid[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const fetchBids = async () => {
    try {
      const res = await ctmApi.getMyListingBids() as { bids: ListingBid[] }
      setBids(res.bids ?? [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchBids() }, [])

  const handleCancel = async (bidId: string) => {
    if (!confirm('Cancel this bid?')) return
    setCancelling(bidId)
    try {
      await ctmApi.cancelListingBid(bidId)
      setBids((prev) => prev.map((b) => b.id === bidId ? { ...b, status: 'cancelled' } : b))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to cancel bid')
    } finally {
      setCancelling(null)
    }
  }

  if (loading) return (
    <div className="max-w-3xl mx-auto px-4 py-12 space-y-3">
      {[1, 2, 3].map((i) => <div key={i} className="bg-surface rounded-xl h-24 border border-border animate-pulse" />)}
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">My Bids</h1>
        <Link href="/ctm/listings" className="text-sm text-primary hover:underline">Browse listings →</Link>
      </div>

      {bids.length === 0 && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-10 text-center">
          <p className="text-text-muted mb-4">You haven&apos;t placed any bids yet.</p>
          <Link href="/ctm/listings" className="bg-primary text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors">Browse Listings</Link>
        </div>
      )}

      <div className="space-y-3">
        {bids.map((bid) => (
          <div key={bid.id} className="bg-surface shadow-card border border-border rounded-xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <EntityLogo type="token" slug={bid.listing.token.symbol} size="lg" logoUrl={bid.listing.token.logoUrl} />
                <div>
                  <p className="font-semibold text-text-primary">
                    {bid.listing.side === 'sell' ? 'Buy' : 'Sell'} {bid.listing.token.name}
                  </p>
                  <p className="text-xs text-text-muted">Merchant: @{bid.listing.merchantProfile.user.username}</p>
                </div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLES[bid.status] ?? 'bg-surface-alt text-text-secondary'}`}>{bid.status}</span>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-4 text-sm">
              <div>
                <p className="text-xs text-text-muted">Your bid price</p>
                <p className="font-semibold text-text-primary">PKR {Number(bid.pricePerUnit).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Amount</p>
                <p className="font-semibold text-text-primary">{Number(bid.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {bid.listing.token.symbol}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Total</p>
                <p className="font-semibold text-text-primary">PKR {Number(bid.fiatAmount).toLocaleString()}</p>
              </div>
            </div>

            {bid.message && (
              <p className="mt-3 text-xs text-text-muted italic">&quot;{bid.message}&quot;</p>
            )}

            {bid.status === 'pending' && (
              <p className="mt-2 text-xs text-text-muted">
                Expires {new Date(bid.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              {bid.status === 'accepted' && bid.trade && (
                <button
                  onClick={() => router.push(`/ctm/trade/${bid.trade!.tradeRef}`)}
                  className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 transition-colors"
                >
                  View Trade
                </button>
              )}
              {bid.status === 'pending' && (
                <button
                  onClick={() => handleCancel(bid.id)}
                  disabled={cancelling === bid.id}
                  className="px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  {cancelling === bid.id ? 'Cancelling…' : 'Cancel Bid'}
                </button>
              )}
              <Link
                href={`/ctm/listings/${bid.listingId}`}
                className="px-4 py-2 border border-border text-text-muted text-sm font-medium rounded-lg hover:bg-surface transition-colors"
              >
                View Listing
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
