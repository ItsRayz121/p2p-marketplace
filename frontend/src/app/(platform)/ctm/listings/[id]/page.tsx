'use client'
import { useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useAuthStore } from '@/store/auth.store'

const TIER_COLORS: Record<string, string> = { new: 'bg-gray-100 text-gray-700', basic: 'bg-blue-100 text-blue-700', verified: 'bg-green-100 text-green-700', elite: 'bg-purple-100 text-purple-700' }

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  availableAmount: string
  minOrderPkr: string
  maxOrderPkr: string
  paymentMethods: string[]
  settlementMethod: string
  settlementNote: string
  tradeWindowMins: number
  terms: string
  status: string
  token: { id: string; name: string; symbol: string; logoUrl?: string; riskTier: string; settlementType: string; description: string }
  merchantProfile: { id: string; tier: string; totalCtmTrades: number; completedCtmTrades: number; ctmAvgRating: string; user: { id: string; username: string } }
}

export default function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { user } = useAuthStore()
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [buyerSettlementId, setBuyerSettlementId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const fetchListing = async () => {
    try {
      const res = await ctmApi.getListing(id)
      setListing(res as Listing)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchListing, 30000)

  const handleStartTrade = async () => {
    if (!paymentMethod) { setError('Select a payment method'); return }
    if (!buyerSettlementId.trim()) { setError('Enter your settlement ID (e.g., your Pi UID)'); return }
    setError('')
    setSubmitting(true)
    try {
      if (!listing) return
      // Create a trade from this listing by calling the listing's trade endpoint
      // This endpoint is handled by ctm.trade.routes via listing → trade creation path
      const res = await fetch(`/api/v1/ctm/listings/${id}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentMethod, buyerSettlementId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message ?? 'Failed to start trade')
      router.push(`/ctm/trade/${data.data.tradeRef}`)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to start trade')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 animate-pulse"><div className="bg-white rounded-xl h-64 border border-border" /></div>
  if (!listing) return <div className="max-w-3xl mx-auto px-4 py-12 text-center text-text-muted">Listing not found.</div>

  const isMine = user?.id === listing.merchantProfile.user.id

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
      {/* Listing header */}
      <div className="bg-white border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-4">
            <EntityLogo type="token" slug={listing.token.symbol} size="2xl" logoUrl={listing.token.logoUrl} />
            <div>
              <h1 className="text-xl font-bold text-text-primary">{listing.side === 'sell' ? 'Buy' : 'Sell'} {listing.token.name}</h1>
              <p className="text-text-muted text-sm">{listing.token.symbol} · {listing.token.settlementType}</p>
            </div>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${listing.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{listing.status}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-border pt-4">
          <div>
            <p className="text-xs text-text-muted">Price</p>
            <p className="font-bold text-text-primary">PKR {Number(listing.pricePerUnit).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Available</p>
            <p className="font-bold text-text-primary">{Number(listing.availableAmount).toLocaleString()} {listing.token.symbol}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Min / Max</p>
            <p className="font-bold text-text-primary">PKR {Number(listing.minOrderPkr).toLocaleString()} – {Number(listing.maxOrderPkr).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Trade window</p>
            <p className="font-bold text-text-primary">{listing.tradeWindowMins} min</p>
          </div>
        </div>
      </div>

      {/* Merchant card */}
      <div className="bg-white border border-border rounded-xl p-5">
        <h2 className="font-semibold text-text-primary mb-3">Merchant</h2>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">{listing.merchantProfile.user.username.charAt(0).toUpperCase()}</div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text-primary">{listing.merchantProfile.user.username}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[listing.merchantProfile.tier] ?? 'bg-gray-100 text-gray-700'}`}>{listing.merchantProfile.tier}</span>
            </div>
            <p className="text-xs text-text-muted">{listing.merchantProfile.completedCtmTrades} completed · ⭐ {Number(listing.merchantProfile.ctmAvgRating).toFixed(1)}</p>
          </div>
        </div>
      </div>

      {/* Payment methods */}
      <div className="bg-white border border-border rounded-xl p-5">
        <h2 className="font-semibold text-text-primary mb-3">Payment Methods</h2>
        <div className="flex flex-wrap gap-2">
          {listing.paymentMethods.map((m) => (
            <span key={m} className="bg-surface border border-border px-3 py-1 rounded-full text-sm">{m}</span>
          ))}
        </div>
      </div>

      {/* Terms */}
      {listing.terms && (
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-2">Terms</h2>
          <p className="text-sm text-text-muted whitespace-pre-wrap">{listing.terms}</p>
        </div>
      )}

      {/* CTA */}
      {!isMine && listing.status === 'active' && (
        <button onClick={() => setShowModal(true)} className={`w-full py-3.5 rounded-xl font-bold text-white transition-colors ${listing.side === 'sell' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
          {listing.side === 'sell' ? `Buy ${listing.token.symbol}` : `Sell ${listing.token.symbol}`}
        </button>
      )}

      {/* Trade modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Start Trade</h3>
            {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Payment method</label>
              <div className="flex flex-wrap gap-2">
                {listing.paymentMethods.map((m) => (
                  <button type="button" key={m} onClick={() => setPaymentMethod(m)}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${paymentMethod === m ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Your {listing.merchantProfile.user.username} will send tokens to your {listing.token.symbol} address/UID
              </label>
              <input type="text" placeholder={`Your ${listing.token.name} UID / Address`} value={buyerSettlementId} onChange={(e) => setBuyerSettlementId(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>

            <div className="bg-surface rounded-xl p-3 text-sm">
              <p className="font-medium text-text-primary mb-1">Settlement instructions from merchant:</p>
              <p className="text-text-muted">{listing.settlementNote}</p>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handleStartTrade} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {submitting ? 'Starting…' : 'Start Trade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
