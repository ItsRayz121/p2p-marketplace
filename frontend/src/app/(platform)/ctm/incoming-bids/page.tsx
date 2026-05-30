'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ctmApi, ApiError } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface IncomingBid {
  id: string
  listingId: string
  bidderId: string
  pricePerUnit: string
  tokenAmount: string
  fiatAmount: string
  message?: string
  status: string
  expiresAt: string
  createdAt: string
  bidder: { id: string; username: string }
  trade?: { tradeRef: string; status: string } | null
}

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  status: string
  token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string }
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-surface-alt text-text-muted',
  cancelled: 'bg-surface-alt text-text-muted',
}

function BidCard({ bid, listing, onAccept, onReject, acting }: {
  bid: IncomingBid
  listing: Listing
  onAccept: (bidId: string) => Promise<void>
  onReject: (bidId: string) => Promise<void>
  acting: string | null
}) {
  const router = useRouter()
  const isPending = bid.status === 'pending'
  const listedPrice = Number(listing.pricePerUnit)
  const bidPrice = Number(bid.pricePerUnit)
  const diff = ((bidPrice - listedPrice) / listedPrice) * 100

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <EntityLogo type="token" slug={listing.token.symbol} size="lg" logoUrl={listing.token.logoUrl} />
          <div>
            <p className="font-semibold text-text-primary">{listing.token.name} · {listing.side === 'buy' ? 'Buy' : 'Sell'} listing</p>
            <p className="text-xs text-text-muted">From @{bid.bidder.username}</p>
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_STYLES[bid.status] ?? 'bg-surface-alt text-text-secondary'}`}>{bid.status}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm mb-3">
        <div>
          <p className="text-xs text-text-muted">Bid price</p>
          <p className="font-semibold text-text-primary">PKR {bidPrice.toLocaleString()}</p>
          <p className={`text-xs font-medium ${diff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {diff >= 0 ? '+' : ''}{diff.toFixed(1)}% vs your price
          </p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Amount</p>
          <p className="font-semibold text-text-primary">{Number(bid.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {listing.token.symbol}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Total PKR</p>
          <p className="font-semibold text-text-primary">PKR {Number(bid.fiatAmount).toLocaleString()}</p>
        </div>
      </div>

      {bid.message && (
        <div className="bg-surface border border-border rounded-lg px-3 py-2 mb-3">
          <p className="text-xs text-text-muted italic">&quot;{bid.message}&quot;</p>
        </div>
      )}

      {isPending && (
        <p className="text-xs text-text-muted mb-3">
          Expires {new Date(bid.expiresAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
        </p>
      )}

      <div className="flex gap-2">
        {isPending && (
          <>
            <button
              onClick={() => onAccept(bid.id)}
              disabled={acting === bid.id}
              className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {acting === bid.id ? 'Accepting…' : 'Accept'}
            </button>
            <button
              onClick={() => onReject(bid.id)}
              disabled={acting === bid.id}
              className="px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              Reject
            </button>
          </>
        )}
        {bid.status === 'accepted' && bid.trade && (
          <button
            onClick={() => router.push(`/ctm/trade/${bid.trade!.tradeRef}`)}
            className="px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors"
          >
            View Trade
          </button>
        )}
        <Link
          href={`/ctm/listings/${bid.listingId}`}
          className="px-4 py-2 border border-border text-text-muted text-sm font-medium rounded-lg hover:bg-surface transition-colors"
        >
          Listing
        </Link>
      </div>
    </div>
  )
}

export default function IncomingBidsPage() {
  const router = useRouter()
  const [myListings, setMyListings] = useState<Listing[]>([])
  const [bidsByListing, setBidsByListing] = useState<Record<string, IncomingBid[]>>({})
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')

  useEffect(() => {
    const load = async () => {
      try {
        const res = await ctmApi.getMyListings() as { listings: Listing[] }
        const listings = res.listings ?? []
        setMyListings(listings)

        const bidsMap: Record<string, IncomingBid[]> = {}
        await Promise.all(
          listings.map(async (listing) => {
            try {
              const bids = await ctmApi.getListingBids(listing.id) as IncomingBid[]
              if (bids.length > 0) bidsMap[listing.id] = bids
            } catch {
              // ignore
            }
          }),
        )
        setBidsByListing(bidsMap)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleAccept = async (bidId: string) => {
    setActing(bidId)
    try {
      const trade = await ctmApi.acceptListingBid(bidId) as { tradeRef: string }
      router.push(`/ctm/trade/${trade.tradeRef}`)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to accept bid')
      setActing(null)
    }
  }

  const handleReject = async (bidId: string) => {
    setActing(bidId)
    try {
      await ctmApi.rejectListingBid(bidId)
      setBidsByListing((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          next[key] = (next[key] ?? []).map((b) => b.id === bidId ? { ...b, status: 'rejected' } : b)
        }
        return next
      })
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to reject bid')
    } finally {
      setActing(null)
    }
  }

  const allBids = Object.entries(bidsByListing).flatMap(([listingId, bids]) =>
    bids.map((bid) => ({ bid, listing: myListings.find((l) => l.id === listingId)! }))
  ).filter(({ listing }) => !!listing)

  const filtered = filter === 'pending' ? allBids.filter(({ bid }) => bid.status === 'pending') : allBids
  const pendingCount = allBids.filter(({ bid }) => bid.status === 'pending').length

  if (loading) return (
    <div className="max-w-3xl mx-auto px-4 py-12 space-y-3">
      {[1, 2, 3].map((i) => <div key={i} className="bg-surface rounded-xl h-32 border border-border animate-pulse" />)}
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Incoming Bids</h1>
          {pendingCount > 0 && (
            <p className="text-sm text-yellow-600 font-medium">{pendingCount} pending bid{pendingCount !== 1 ? 's' : ''} awaiting your response</p>
          )}
        </div>
        <Link href="/my-ads?tab=analytics" className="text-sm text-primary hover:underline">Merchant Analytics →</Link>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['pending', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${filter === f ? 'bg-primary text-white' : 'bg-surface border border-border text-text-muted hover:bg-surface'}`}
          >
            {f === 'pending' ? `Pending (${pendingCount})` : 'All bids'}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-10 text-center">
          <p className="text-text-muted">{filter === 'pending' ? 'No pending bids right now.' : 'No bids on your listings yet.'}</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(({ bid, listing }) => (
          <BidCard
            key={bid.id}
            bid={bid}
            listing={listing}
            onAccept={handleAccept}
            onReject={handleReject}
            acting={acting}
          />
        ))}
      </div>
    </div>
  )
}
