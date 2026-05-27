'use client'
import { useState, use, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { adsApi, apiRequest, ApiError } from '@/lib/api'
import type { AdActivity } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useAuth } from '@/hooks/useAuth'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

const METHOD_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank Transfer',
}

interface ResolvedPaymentMethod { id: string; type: string; label: string }

interface SavedPaymentMethod {
  id: string
  type: string
  displayName: string
  accountName: string
  mobileNumber?: string
  bankName?: string
  ibanNumber?: string
  accountNumber?: string
}

interface AdDetail {
  id: string
  side: string
  coin: string
  network: string
  price: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  resolvedPaymentMethods: ResolvedPaymentMethod[]
  tradeWindow: number
  terms: string
  status: string
  user: { id: string; username: string; tradeStats?: { totalTrades: number; completedTrades: number; completionRate: string } | null }
}

type MyActiveBid = NonNullable<AdActivity['myBid']>

export default function AdListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { user } = useAuth()

  const [ad, setAd] = useState<AdDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activity, setActivity] = useState<AdActivity | null>(null)
  const [myActiveBid, setMyActiveBid] = useState<MyActiveBid | null>(null)
  const [activeTab, setActiveTab] = useState<'bids' | 'trades'>('bids')
  const [bidActionId, setBidActionId] = useState<string | null>(null)
  const [error, setError] = useState('')

  // Bid modal
  const [showBidModal, setShowBidModal] = useState(false)
  const [bidPrice, setBidPrice] = useState('')
  const [bidAmount, setBidAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Confirm bid details modal
  const [showConfirmModal, setShowConfirmModal] = useState(false)
  const [confirmPaymentMethod, setConfirmPaymentMethod] = useState('')
  const [confirmUsdtAddress, setConfirmUsdtAddress] = useState('')
  const [confirmSubmitting, setConfirmSubmitting] = useState(false)
  const [confirmError, setConfirmError] = useState('')

  // Collapsible cards
  const [sellerOpen, setSellerOpen] = useState(true)
  const [paymentOpen, setPaymentOpen] = useState(true)
  const [networkOpen, setNetworkOpen] = useState(true)

  // Buyer's own saved payment methods
  const [myMethods, setMyMethods] = useState<ResolvedPaymentMethod[]>([])

  const fetchAd = useCallback(async () => {
    try {
      const res = await adsApi.getAd(id)
      setAd(res as AdDetail)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [id])

  const fetchActivity = useCallback(async () => {
    try {
      const res = await adsApi.getAdActivity(id)
      setActivity(res)
      if (res.myBid !== undefined) setMyActiveBid(res.myBid ?? null)
    } catch { /* ignore */ }
  }, [id])

  usePolling(fetchAd, 30000)
  usePolling(fetchActivity, 60000)

  useEffect(() => {
    if (user) {
      apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods').then((methods) => {
        const resolved: ResolvedPaymentMethod[] = (Array.isArray(methods) ? methods : []).map((m) => ({
          id: m.id,
          type: m.type,
          label: m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (METHOD_LABELS[m.type] ?? m.type),
        }))
        setMyMethods(resolved)
      }).catch(() => {})
    }
  }, [user])

  const handleAcceptBid = async (bidId: string) => {
    setBidActionId(bidId)
    try {
      const res = await adsApi.acceptBid(bidId)
      if (res.status === 'accepted_pending_buyer') fetchActivity()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to accept bid')
    } finally {
      setBidActionId(null)
    }
  }

  const handleRejectBid = async (bidId: string) => {
    setBidActionId(bidId)
    try {
      await adsApi.rejectBid(bidId)
      fetchActivity()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to reject bid')
    } finally {
      setBidActionId(null)
    }
  }

  const handlePlaceBid = async () => {
    if (!bidPrice.trim() || parseFloat(bidPrice) <= 0) { setError('Enter your bid price'); return }
    if (!bidAmount.trim() || parseFloat(bidAmount) <= 0) { setError('Enter a USDT amount'); return }
    setError('')
    setSubmitting(true)
    try {
      const bid = await adsApi.placeBid(id, { pricePerUnit: parseFloat(bidPrice), usdtAmount: parseFloat(bidAmount) })
      setMyActiveBid({ id: bid.id, status: bid.status, expiresAt: bid.expiresAt, pricePerUnit: bid.pricePerUnit, usdtAmount: bid.usdtAmount, fiatAmount: bid.fiatAmount })
      setShowBidModal(false)
      fetchActivity()
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : (err as Error).message ?? 'Failed to place bid')
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirmBidDetails = async () => {
    if (!confirmPaymentMethod) { setConfirmError('Select a payment method'); return }
    if (ad?.side === 'sell' && !confirmUsdtAddress.trim()) { setConfirmError('Enter your USDT receiving address'); return }
    setConfirmError('')
    setConfirmSubmitting(true)
    try {
      const trade = await adsApi.confirmBidDetails(myActiveBid!.id, {
        paymentMethod: confirmPaymentMethod,
        ...(ad?.side === 'sell' ? { buyerUsdtAddress: confirmUsdtAddress.trim() } : {}),
      })
      router.push(`/trade/${trade.id}`)
    } catch (err: unknown) {
      setConfirmError(err instanceof ApiError ? err.message : (err as Error).message ?? 'Failed to confirm details')
    } finally {
      setConfirmSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 animate-pulse"><div className="bg-white rounded-xl h-64 border border-border" /></div>
  if (!ad) return <div className="max-w-3xl mx-auto px-4 py-12 text-center text-text-muted">Listing not found.</div>

  const isMine = user?.id === ad.user.id
  const isSellAd = ad.side === 'sell'
  const resolvedMethods = ad.resolvedPaymentMethods ?? ad.paymentMethods.map((pm) => ({ id: pm, type: pm, label: METHOD_LABELS[pm] ?? pm }))

  // SELL ad: lister=SELLER, taker=BUYER → buyer picks from seller's accepted methods
  // BUY ad: lister=BUYER, taker=SELLER → seller picks their own receiving account
  const confirmModalMethods: ResolvedPaymentMethod[] = isSellAd ? resolvedMethods : myMethods

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

      {/* Listing header */}
      <div className="bg-white border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-xl font-bold text-primary flex-shrink-0">$</div>
            <div>
              <h1 className="text-xl font-bold text-text-primary">
                {isMine
                  ? (isSellAd ? 'Sell' : 'Buy')
                  : (isSellAd ? 'Buy' : 'Sell')} {ad.coin}
              </h1>
              <p className="text-text-muted text-sm">{ad.coin} · {ad.network}</p>
            </div>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${ad.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{ad.status}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-border pt-4">
          <div>
            <p className="text-xs text-text-muted">Price</p>
            <p className="font-bold text-text-primary">PKR {Number(ad.price).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{isSellAd ? 'Available' : 'Wanted'}</p>
            <p className="font-bold text-text-primary">{Number(ad.availableAmount).toFixed(4)} {ad.coin}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Min / Max</p>
            <p className="font-bold text-text-primary">{Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} {ad.coin}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Trade window</p>
            <p className="font-bold text-text-primary">{ad.tradeWindow} min</p>
          </div>
        </div>
      </div>

      {/* Seller / Buyer card — collapsible */}
      <div className="bg-white border border-border rounded-xl p-5">
        <button onClick={() => setSellerOpen((o) => !o)} className="w-full flex items-center justify-between text-left mb-0">
          <h2 className="font-semibold text-text-primary">{isSellAd ? 'Seller' : 'Buyer'}</h2>
          <svg className={`w-4 h-4 text-text-muted transition-transform ${sellerOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {sellerOpen && (
          <div className="flex items-center gap-3 mt-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center flex-shrink-0">
              {ad.user.username.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="font-semibold text-text-primary">{ad.user.username}</p>
              {ad.user.tradeStats && (
                <p className="text-xs text-text-muted">
                  {ad.user.tradeStats.completedTrades} completed · {(Number(ad.user.tradeStats.completionRate) * 100).toFixed(0)}% completion
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Payment methods card — collapsible */}
      <div className="bg-white border border-border rounded-xl p-5">
        <button onClick={() => setPaymentOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
          <h2 className="font-semibold text-text-primary">
            {isSellAd
              ? isMine ? 'Your Accepted Payment Methods' : 'Seller Accepted Payment Methods'
              : isMine ? 'Your Accepted Payment Methods' : 'Buyer Accepted Payment Methods'}
          </h2>
          <svg className={`w-4 h-4 text-text-muted transition-transform ${paymentOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {paymentOpen && (
          <div className="mt-3">
            <p className="text-xs text-text-muted mb-3">
              {isSellAd
                ? isMine ? 'These are the payment methods you accept from buyers.' : 'These are the methods this seller accepts from buyers.'
                : isMine ? 'These are the payment methods you accept from sellers.' : 'These are the methods this buyer accepts from sellers.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {resolvedMethods.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 bg-surface border border-border px-3 py-1 rounded-full text-sm">
                  <EntityLogo type={PK_MOBILE_METHODS.includes(m.id) ? 'payment_method' : 'bank'} slug={m.id} size="xs" className="flex-shrink-0" />
                  {m.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* USDT Network card — collapsible */}
      <div className="bg-white border border-border rounded-xl p-5">
        <button onClick={() => setNetworkOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
          <h2 className="font-semibold text-text-primary">USDT Network</h2>
          <svg className={`w-4 h-4 text-text-muted transition-transform ${networkOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {networkOpen && (
          <p className="text-sm text-text-muted mt-3">
            {isSellAd
              ? isMine
                ? `You will send USDT to the buyer via the ${ad.network} network.`
                : `Seller will send USDT to you via the ${ad.network} network. Make sure to provide a receiving address on this network.`
              : isMine
                ? `Sellers will send USDT to your ${ad.network} address after you confirm payment.`
                : `Send USDT to the buyer's ${ad.network} address after the buyer confirms payment.`}
          </p>
        )}
      </div>

      {/* Terms */}
      {ad.terms && (
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-2">Terms</h2>
          <p className="text-sm text-text-muted whitespace-pre-wrap">{ad.terms}</p>
        </div>
      )}

      {/* Activity stats bar — public */}
      {activity && (
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-3">Listing Activity</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-lg font-bold text-text-primary">{activity.bids.pendingCount}</p>
              <p className="text-xs text-text-muted">Pending Bids</p>
            </div>
            {activity.bids.pendingCount > 0 && activity.bids.minPrice && (
              <div>
                <p className="text-lg font-bold text-text-primary">
                  PKR {Number(activity.bids.minPrice).toLocaleString()}–{Number(activity.bids.maxPrice!).toLocaleString()}
                </p>
                <p className="text-xs text-text-muted">Bid Price Range</p>
              </div>
            )}
            <div>
              <p className="text-lg font-bold text-text-primary">{activity.trades.activeCount}</p>
              <p className="text-xs text-text-muted">Active Trades</p>
            </div>
            <div>
              <p className="text-lg font-bold text-text-primary">{activity.trades.completedCount}</p>
              <p className="text-xs text-text-muted">Completed</p>
            </div>
            {activity.trades.lastTradePrice && (
              <div>
                <p className="text-lg font-bold text-text-primary">PKR {Number(activity.trades.lastTradePrice).toLocaleString()}</p>
                <p className="text-xs text-text-muted">Last Trade Price</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Owner management panel — tabbed bids + trades */}
      {isMine && activity && (
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 w-fit mb-4">
            {(['bids', 'trades'] as const).map((t) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`px-5 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeTab === t ? 'bg-white text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}>
                {t === 'bids'
                  ? `Pending Bids (${activity.bids.pendingCount})`
                  : `Trades (${activity.trades.activeCount + activity.trades.completedCount})`}
              </button>
            ))}
          </div>

          {activeTab === 'bids' && (
            !activity.bids.items || activity.bids.items.length === 0
              ? <p className="text-sm text-text-muted text-center py-6">No pending bids.</p>
              : <div className="space-y-3">
                  {activity.bids.items.map((bid) => (
                    <div key={bid.id} className="flex items-start justify-between gap-3 bg-surface rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-primary">PKR {Number(bid.pricePerUnit).toLocaleString()} / {ad.coin}</p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {bid.bidder?.username} · {Number(bid.usdtAmount).toLocaleString()} {ad.coin} · PKR {Number(bid.fiatAmount).toLocaleString()} total
                        </p>
                        {bid.message && <p className="text-xs text-text-muted italic mt-0.5">&ldquo;{bid.message}&rdquo;</p>}
                      </div>
                      <div className="flex gap-2 flex-shrink-0 items-start">
                        {bid.status === 'accepted_pending_buyer' ? (
                          <span className="text-xs px-3 py-1.5 rounded-lg bg-amber-100 text-amber-700 font-medium">Awaiting buyer</span>
                        ) : (
                          <>
                            <button onClick={() => handleAcceptBid(bid.id)} disabled={bidActionId === bid.id}
                              className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60 transition-colors">
                              {bidActionId === bid.id ? '…' : 'Accept'}
                            </button>
                            <button onClick={() => handleRejectBid(bid.id)} disabled={bidActionId === bid.id}
                              className="border border-border text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-white disabled:opacity-60 transition-colors">
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
          )}

          {activeTab === 'trades' && (
            !activity.trades.items || activity.trades.items.length === 0
              ? <p className="text-sm text-text-muted text-center py-6">No trades yet.</p>
              : <div className="space-y-3">
                  {activity.trades.items.map((t) => (
                    <div key={t.orderRef} className="flex items-start justify-between gap-3 bg-surface rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-primary">
                          {Number(t.amount).toLocaleString()} {ad.coin} · PKR {Number(t.fiatAmount).toLocaleString()}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {t.buyer.username} → {t.seller.username} · PKR {Number(t.price).toLocaleString()}/{ad.coin}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          t.status === 'crypto_released' ? 'bg-green-100 text-green-700' :
                          t.status === 'cancelled'       ? 'bg-gray-100 text-gray-600'  :
                          t.status === 'disputed'        ? 'bg-red-100 text-red-700'    :
                          'bg-blue-100 text-blue-700'
                        }`}>{t.status.replace(/_/g, ' ')}</span>
                        <p className="text-xs text-text-muted mt-1">
                          <a href={`/trade/${t.id}`} className="text-primary hover:underline">View →</a>
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
          )}
        </div>
      )}

      {/* Complete Trade banner — shown when buyer's bid was accepted but payment details not yet provided */}
      {!isMine && myActiveBid?.status === 'accepted_pending_buyer' && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
          <p className="font-semibold text-amber-900">Your bid was accepted!</p>
          <p className="text-sm text-amber-700 mt-1">
            Complete your payment details to open the trade. The window expires at{' '}
            {new Date(myActiveBid.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          </p>
          <button
            onClick={() => { setShowConfirmModal(true); setConfirmPaymentMethod(''); setConfirmUsdtAddress(''); setConfirmError('') }}
            className="mt-3 bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-amber-700 transition-colors"
          >
            Complete Trade Details
          </button>
        </div>
      )}

      {/* CTA */}
      {!isMine && ad.status === 'active' && !myActiveBid && (
        <button
          onClick={() => { setShowBidModal(true); setBidPrice(''); setBidAmount(''); setError('') }}
          className={`w-full py-3.5 rounded-xl font-bold text-white transition-colors ${isSellAd ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {isSellAd ? `Buy ${ad.coin} — Place Bid` : `Sell ${ad.coin} — Place Bid`}
        </button>
      )}

      {/* Pending bid notice */}
      {!isMine && myActiveBid?.status === 'pending' && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
          You have a pending bid on this listing. Waiting for the owner to respond.
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{error}</div>}

      {/* Bid modal */}
      {showBidModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-lg text-text-primary">Place a Bid</h3>
              <p className="text-xs text-text-muted mt-0.5">Offer your own price. The owner has 30 minutes to accept or reject.</p>
            </div>
            {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Your bid price per {ad.coin} (PKR)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">PKR</span>
                <input type="number" min={0} step="0.01"
                  placeholder={`Listed at ${Number(ad.price).toLocaleString()}`}
                  value={bidPrice} onChange={(e) => setBidPrice(e.target.value)}
                  className="w-full border border-border rounded-xl pl-12 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <p className="text-xs text-text-muted mt-1">Listed price: PKR {Number(ad.price).toLocaleString()}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {isSellAd ? `How many ${ad.coin} do you want to buy?` : `How many ${ad.coin} will you sell?`}
              </label>
              <div className="relative">
                <input type="number" min={Number(ad.minOrder)} max={Math.min(Number(ad.maxOrder), Number(ad.availableAmount))} step="0.000001"
                  placeholder={`${Number(ad.minOrder).toLocaleString()} – ${Number(ad.maxOrder).toLocaleString()}`}
                  value={bidAmount} onChange={(e) => setBidAmount(e.target.value)}
                  className="w-full border border-border rounded-xl pl-3 pr-16 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">{ad.coin}</span>
              </div>
              <p className="text-xs text-text-muted mt-1">Min {Number(ad.minOrder).toLocaleString()} · Max {Number(ad.maxOrder).toLocaleString()} {ad.coin}</p>
            </div>

            {bidPrice && bidAmount && (() => {
              const price = parseFloat(bidPrice)
              const amount = parseFloat(bidAmount)
              const total = price * amount
              return (
                <div className="bg-surface rounded-xl border border-border p-4 space-y-2 text-sm">
                  <p className="font-semibold text-text-primary mb-2">Bid Summary</p>
                  <div className="flex justify-between"><span className="text-text-muted">Your bid price</span><span className="font-medium text-text-primary">PKR {price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
                  <div className="flex justify-between"><span className="text-text-muted">{ad.coin} amount</span><span className="font-medium text-text-primary">{amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} {ad.coin}</span></div>
                  <div className="flex justify-between border-t border-border pt-2 font-semibold">
                    <span className="text-text-muted">{isSellAd ? 'Total payable' : 'Total you receive'}</span>
                    <span className="text-text-primary">PKR {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              )
            })()}

            <p className="text-xs text-text-muted bg-blue-50 border border-blue-100 rounded-xl px-3 py-2">
              Payment details and your {ad.coin} wallet address will be collected after the owner accepts your bid.
            </p>

            <div className="flex gap-3">
              <button onClick={() => setShowBidModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handlePlaceBid} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
                {submitting ? 'Placing…' : 'Place Bid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Bid Details modal — shown after owner accepts bid */}
      {showConfirmModal && myActiveBid && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-lg text-text-primary">Complete Trade Details</h3>
              <p className="text-xs text-text-muted mt-0.5">Your bid was accepted. Provide payment details to open the trade.</p>
            </div>

            <div className="bg-surface rounded-xl border border-border p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-text-muted">Bid price</span><span className="font-medium text-text-primary">PKR {Number(myActiveBid.pricePerUnit).toLocaleString()}/{ad.coin}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">Amount</span><span className="font-medium text-text-primary">{Number(myActiveBid.usdtAmount).toLocaleString()} {ad.coin}</span></div>
              <div className="flex justify-between border-t border-border pt-1 font-semibold">
                <span className="text-text-muted">{isSellAd ? 'Total payable' : 'Total you receive'}</span>
                <span className="text-text-primary">PKR {Number(myActiveBid.fiatAmount).toLocaleString()}</span>
              </div>
            </div>

            {confirmError && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{confirmError}</div>}

            {/* Payment method selection */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-0.5">
                {isSellAd ? "Select the seller's payment account you'll send payment to" : 'Choose where you want to receive payment (PKR)'}
              </label>
              {!isSellAd && myMethods.length === 0 && (
                <p className="text-xs text-text-muted bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                  No saved payment accounts. <a href="/payment-methods" className="text-primary underline">Add one →</a>
                </p>
              )}
              <div className="flex flex-wrap gap-2 mt-1.5">
                {confirmModalMethods.map((m) => (
                  <button type="button" key={m.id}
                    onClick={() => setConfirmPaymentMethod(confirmPaymentMethod === m.id ? '' : m.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${confirmPaymentMethod === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}
                  >
                    <EntityLogo type={PK_MOBILE_METHODS.includes(m.id) ? 'payment_method' : 'bank'} slug={m.id} size="xs" className="flex-shrink-0" />
                    {m.label}
                    {confirmPaymentMethod === m.id && <span className="ml-0.5 text-xs">✓</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* USDT receiving address — only when buying (SELL ad) */}
            {isSellAd && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Your {ad.coin} receiving address ({ad.network})
                </label>
                <input type="text"
                  placeholder={`Your ${ad.network} wallet address or exchange deposit address`}
                  value={confirmUsdtAddress}
                  onChange={(e) => setConfirmUsdtAddress(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="mt-1 text-xs text-text-muted">The seller will send {ad.coin} here after your payment is confirmed.</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setShowConfirmModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handleConfirmBidDetails} disabled={confirmSubmitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
                {confirmSubmitting ? 'Opening Trade…' : 'Open Trade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
