'use client'
import { useState, use, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ctmApi, apiRequest, ApiError, walletApi } from '@/lib/api'
import type { SavedDeliveryAddress } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAuth } from '@/hooks/useAuth'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { Star } from 'lucide-react'

const TIER_COLORS: Record<string, string> = { new: 'bg-surface-alt text-text-secondary', basic: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', verified: 'bg-green-500/15 text-green-700 dark:text-green-300', elite: 'bg-primary/10 text-primary' }

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

interface ActivityBid {
  id: string
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
interface ActivityTrade {
  tradeRef: string
  status: string
  tokenAmount: string
  pricePerUnit: string
  fiatAmount: string
  createdAt: string
  completedAt?: string | null
  buyer: { username: string }
  seller: { username: string }
}
interface MyActiveBid {
  id: string
  status: string
  expiresAt: string
  pricePerUnit: string
  tokenAmount: string
  fiatAmount: string
}
interface ListingActivity {
  myBid?: MyActiveBid | null
  bids:   { pendingCount: number; minPrice: string | null; maxPrice: string | null; items?: ActivityBid[] }
  trades: { activeCount: number; completedCount: number; lastTradePrice: string | null; lastTradeAt: string | null; items?: ActivityTrade[] }
}

interface Listing {
  id: string
  side: string
  pricePerUnit: string
  availableAmount: string
  minOrderTokens: string
  maxOrderTokens: string
  paymentMethods: string[]
  resolvedPaymentMethods: ResolvedPaymentMethod[]
  tokenDeliveryType?: string
  settlementMethod: string
  settlementNote: string
  tradeWindowMins: number
  terms: string
  status: string
  token: { id: string; name: string; symbol: string; logoUrl?: string; riskTier: string; settlementType: string; description: string }
  merchantProfile: { id: string; tier: string; totalCtmTrades: number; completedCtmTrades: number; ctmAvgRating: string; user: { id: string; username: string; fullName: string | null; avatarUrl: string | null } }
}

const DELIVERY_LABELS: Record<string, string> = {
  blockchain: 'Wallet / Blockchain',
  email: 'Email',
  username: 'Username',
}

function buyerAddressLabel(tokenDeliveryType: string | undefined, tokenName: string): string {
  if (tokenDeliveryType === 'blockchain') return `Your ${tokenName} wallet address`
  if (tokenDeliveryType === 'email') return 'Your email address (to receive the token)'
  if (tokenDeliveryType === 'username') return `Your username on the ${tokenName} platform`
  return 'Your receiving address / identifier'
}

function buyerAddressPlaceholder(tokenDeliveryType: string | undefined, tokenSymbol: string): string {
  if (tokenDeliveryType === 'blockchain') return `0x… or your ${tokenSymbol} wallet address`
  if (tokenDeliveryType === 'email') return 'you@example.com'
  if (tokenDeliveryType === 'username') return `Your ${tokenSymbol} username`
  return 'Your receiving address'
}

export default function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { user } = useAuth()
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [showBidModal, setShowBidModal] = useState(false)
  const [paymentMethodId, setPaymentMethodId] = useState('')            // SELL listing: which seller account to pay TO
  const [buyerFromMethodId, setBuyerFromMethodId] = useState('')         // SELL listing: which buyer account to pay FROM (informational)
  const [paymentMethodIds, setPaymentMethodIds] = useState<string[]>([]) // BUY listing: seller picks multiple own accounts
  const [buyerSettlementId, setBuyerSettlementId] = useState('')
  const [tokenAmount, setTokenAmount] = useState('')
  const [bidPrice, setBidPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Seller's own payment methods — needed when taking a BUY listing
  const [myMethods, setMyMethods] = useState<ResolvedPaymentMethod[]>([])
  // Saved CTM-token receiving addresses the buyer can reuse instead of re-typing.
  const [savedAddresses, setSavedAddresses] = useState<SavedDeliveryAddress[]>([])
  // Activity hub
  const [activity, setActivity] = useState<ListingActivity | null>(null)
  const [myActiveBid, setMyActiveBid] = useState<MyActiveBid | null>(null)
  const [activeTab, setActiveTab] = useState<'bids' | 'trades'>('bids')
  const [bidActionId, setBidActionId] = useState<string | null>(null)
  // Confirm bid details modal (shown after merchant accepts bid with no payment info)
  const [showConfirmBidModal, setShowConfirmBidModal] = useState(false)
  const [confirmPaymentMethodId, setConfirmPaymentMethodId] = useState('')
  const [confirmBuyerFromMethodId, setConfirmBuyerFromMethodId] = useState('')
  const [confirmPaymentMethodIds, setConfirmPaymentMethodIds] = useState<string[]>([])
  const [confirmBuyerSettlementId, setConfirmBuyerSettlementId] = useState('')
  const [confirmMessage, setConfirmMessage] = useState('')
  const [confirmSubmitting, setConfirmSubmitting] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  // Collapsible cards
  const [merchantOpen, setMerchantOpen] = useState(true)
  const [paymentOpen, setPaymentOpen] = useState(true)
  const [deliveryOpen, setDeliveryOpen] = useState(true)

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

  const fetchActivity = useCallback(async () => {
    try {
      const res = await ctmApi.getListingActivity(id)
      const act = res as ListingActivity
      setActivity(act)
      if (act.myBid) setMyActiveBid(act.myBid)
      else if (act.myBid === null) setMyActiveBid(null)
    } catch { /* ignore */ }
  }, [id])

  usePolling(fetchActivity, 60000)

  const handleAcceptBid = async (bidId: string) => {
    setBidActionId(bidId)
    try {
      const res = await ctmApi.acceptListingBid(bidId)
      if (res.status === 'accepted_pending_buyer') {
        fetchActivity()
      } else if (res.tradeRef) {
        router.push(`/ctm/trade/${res.tradeRef}`)
      }
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to accept bid')
      setBidActionId(null)
    }
  }

  const handleRejectBid = async (bidId: string) => {
    setBidActionId(bidId)
    try {
      await ctmApi.rejectListingBid(bidId)
      fetchActivity()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to reject bid')
    } finally {
      setBidActionId(null)
    }
  }

  // Always load the current user's own saved payment methods:
  // BUY listings: user is the seller-taker, picks their own receiving account
  // SELL listings: user is the buyer, picks which of their accounts they'll pay from
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
      walletApi.getSavedAddresses().then((addrs) => {
        setSavedAddresses(Array.isArray(addrs) ? addrs : [])
      }).catch(() => {})
    }
  }, [user])

  const handleStartTrade = async () => {
    if (isBuyListing && paymentMethodIds.length === 0) { setError('Select at least one payment receiving account'); return }
    if (!isBuyListing && !paymentMethodId) { setError('Select a payment method'); return }
    if (!tokenAmount.trim() || parseFloat(tokenAmount) <= 0) { setError('Enter a token amount'); return }
    // SELL listings: buyer must provide their token receiving address
    if (listing?.side === 'sell' && !buyerSettlementId.trim()) {
      setError('Enter your token receiving address'); return
    }
    setError('')
    setSubmitting(true)
    try {
      if (!listing) return
      const res = await ctmApi.startListingTrade(id, {
        // BUY listing: seller provides multiple receiving accounts; SELL listing: buyer picks one seller account
        paymentMethod: isBuyListing ? undefined : paymentMethodId,
        paymentMethods: isBuyListing ? paymentMethodIds : undefined,
        // For SELL listings: buyer provides their address. For BUY listings: address is on the listing.
        buyerSettlementId: listing.side === 'sell' ? (buyerSettlementId.trim() || undefined) : undefined,
        // For SELL listings: snapshot which of the buyer's accounts they'll pay FROM
        buyerPaymentMethodId: !isBuyListing && buyerFromMethodId ? buyerFromMethodId : undefined,
        tokenAmount: parseFloat(tokenAmount),
      })
      router.push(`/ctm/trade/${res.tradeRef}`)
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError((err as Error).message ?? 'Failed to start trade. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handlePlaceBid = async () => {
    if (!bidPrice.trim() || parseFloat(bidPrice) <= 0) { setError('Enter your bid price'); return }
    if (!tokenAmount.trim() || parseFloat(tokenAmount) <= 0) { setError('Enter a token amount'); return }
    setError('')
    setSubmitting(true)
    try {
      const bid = await ctmApi.placeListingBid(id, {
        pricePerUnit: parseFloat(bidPrice),
        tokenAmount: parseFloat(tokenAmount),
      })
      setMyActiveBid(bid as MyActiveBid)
      setShowBidModal(false)
      fetchActivity()
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError((err as Error).message ?? 'Failed to place bid. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirmBidDetails = async () => {
    if (!myActiveBid || !listing) return
    const isBuy = listing.side === 'buy'
    if (isBuy && confirmPaymentMethodIds.length === 0) { setConfirmError('Select at least one payment receiving account'); return }
    if (!isBuy && !confirmPaymentMethodId) { setConfirmError('Select a payment method'); return }
    if (!isBuy && !confirmBuyerSettlementId.trim()) { setConfirmError('Enter your token receiving address'); return }
    setConfirmError('')
    setConfirmSubmitting(true)
    try {
      const trade = await ctmApi.confirmBidDetails(myActiveBid.id, {
        paymentMethod: isBuy ? undefined : confirmPaymentMethodId,
        paymentMethods: isBuy ? confirmPaymentMethodIds : undefined,
        buyerSettlementId: !isBuy ? (confirmBuyerSettlementId.trim() || undefined) : undefined,
        buyerPaymentMethodId: !isBuy && confirmBuyerFromMethodId ? confirmBuyerFromMethodId : undefined,
        message: confirmMessage.trim() || undefined,
      })
      router.push(`/ctm/trade/${trade.tradeRef}`)
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setConfirmError(err.message)
      } else {
        setConfirmError((err as Error).message ?? 'Failed to confirm details. Please try again.')
      }
    } finally {
      setConfirmSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 animate-pulse"><div className="bg-surface rounded-xl h-64 border border-border" /></div>
  if (!listing) return <div className="max-w-3xl mx-auto px-4 py-12 text-center text-text-muted">Listing not found.</div>

  const isMine = user?.id === listing.merchantProfile.user.id
  const isBuyListing = listing.side === 'buy'
  const resolvedMethods = listing.resolvedPaymentMethods ?? listing.paymentMethods.map((m) => ({
    id: m,
    type: PK_MOBILE_METHODS.includes(m) ? m : 'bank_transfer',
    label: m,
  }))

  // BUY listings (lister=BUYER, taker=SELLER):
  //   taker picks their own payment receiving account (buyer will send PKR here)
  // SELL listings (lister=SELLER, taker=BUYER):
  //   show all seller's accepted methods; buyer picks which account to send payment to
  const modalPaymentMethods: ResolvedPaymentMethod[] = isBuyListing
    ? myMethods       // taker is seller, selects their own receiving account
    : resolvedMethods // taker is buyer, picks from all seller's accepted accounts

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
      {/* Listing header */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-4">
            <EntityLogo type="token" slug={listing.token.symbol} size="2xl" logoUrl={listing.token.logoUrl} />
            <div>
              <h1 className="text-xl font-bold text-text-primary">
                {isMine
                  ? listing.side === 'sell' ? 'Sell' : 'Buy'
                  : listing.side === 'sell' ? 'Buy' : 'Sell'} {listing.token.name}
              </h1>
              <p className="text-text-muted text-sm">{listing.token.symbol} · {listing.token.settlementType}</p>
            </div>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${listing.status === 'active' ? 'bg-green-500/15 text-green-700 dark:text-green-300' : 'bg-surface-alt text-text-secondary'}`}>{listing.status.charAt(0).toUpperCase() + listing.status.slice(1)}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 border-t border-border pt-4">
          <div>
            <p className="text-xs text-text-muted">Price</p>
            <p className="font-bold text-text-primary">PKR {Number(listing.pricePerUnit).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{listing.side === 'buy' ? 'Wanted' : 'Available'}</p>
            <p className="font-bold text-text-primary">{Number(listing.availableAmount).toLocaleString()} {listing.token.symbol}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Min / Max</p>
            <p className="font-bold text-text-primary">{Number(listing.minOrderTokens).toLocaleString()} – {Number(listing.maxOrderTokens).toLocaleString()} {listing.token.symbol}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Trade window</p>
            <p className="font-bold text-text-primary">{listing.tradeWindowMins} min</p>
          </div>
        </div>
      </div>

      {/* Merchant card */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <button onClick={() => setMerchantOpen((o) => !o)} className="w-full flex items-center justify-between text-left mb-0">
          <h2 className="font-semibold text-text-primary">Merchant</h2>
          <svg className={`w-4 h-4 text-text-muted transition-transform ${merchantOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {merchantOpen && (
          <Link
            href={`/profile/${encodeURIComponent(listing.merchantProfile.user.username)}`}
            className="flex items-center gap-3 mt-3 group"
          >
            <UserAvatar
              name={listing.merchantProfile.user.fullName || listing.merchantProfile.user.username}
              avatarUrl={listing.merchantProfile.user.avatarUrl}
              size="md"
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text-primary group-hover:text-primary group-hover:underline transition-colors">{listing.merchantProfile.user.fullName || listing.merchantProfile.user.username}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[listing.merchantProfile.tier] ?? 'bg-surface-alt text-text-secondary'}`}>{listing.merchantProfile.tier}</span>
              </div>
              <p className="text-xs text-text-muted">@{listing.merchantProfile.user.username}</p>
              <p className="text-xs text-text-muted flex items-center gap-1">{listing.merchantProfile.completedCtmTrades} completed · <Star size={10} className="text-warning fill-warning" />{Number(listing.merchantProfile.ctmAvgRating).toFixed(1)}</p>
            </div>
          </Link>
        )}
      </div>

      {/* Payment / receiving info section */}
      {isBuyListing ? (
        // BUY listing: lister is BUYER — most important info is buyer's token receiving address
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <button onClick={() => setPaymentOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
            <h2 className="font-semibold text-text-primary">
              {isMine ? 'Your Token Receiving Address' : "Buyer's Token Receiving Address"}
            </h2>
            <svg className={`w-4 h-4 text-text-muted transition-transform ${paymentOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {paymentOpen && (
            <div className="mt-3">
              <p className="text-xs text-text-muted mb-3">
                {isMine
                  ? 'Sellers will send tokens to this address after you confirm payment.'
                  : 'Send tokens to this address after the buyer confirms payment.'}
              </p>
              {listing.settlementMethod ? (
                <p className="text-sm font-mono bg-surface border border-border rounded-lg px-3 py-2 break-all text-text-primary">
                  {listing.settlementMethod}
                </p>
              ) : (
                <p className="text-sm text-text-muted italic">No receiving address provided.</p>
              )}
            </div>
          )}
        </div>
      ) : (
        // SELL listing: lister is SELLER — show their accepted payment methods
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <button onClick={() => setPaymentOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
            <h2 className="font-semibold text-text-primary">
              {isMine ? 'Your Accepted Payment Methods' : 'Seller Accepted Payment Methods'}
            </h2>
            <svg className={`w-4 h-4 text-text-muted transition-transform ${paymentOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {paymentOpen && (
            <div className="mt-3">
              <p className="text-xs text-text-muted mb-3">
                {isMine
                  ? 'These are the payment methods you accept from buyers.'
                  : 'These are the methods this seller accepts from buyers.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {resolvedMethods.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1.5 bg-surface border border-border px-3 py-1 rounded-full text-sm">
                    <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delivery method */}
      {listing.tokenDeliveryType && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <button onClick={() => setDeliveryOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
            <h2 className="font-semibold text-text-primary">Token Delivery Method</h2>
            <svg className={`w-4 h-4 text-text-muted transition-transform ${deliveryOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {deliveryOpen && (
            <p className="text-sm text-text-muted mt-3">
              {listing.side === 'sell'
                ? isMine
                  ? `You will send tokens to the buyer via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
                  : `Seller will send tokens to you via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
                : isMine
                  ? `Sellers will send tokens to your address via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
                  : `Send tokens to the buyer's address via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`}
            </p>
          )}
        </div>
      )}

      {/* Terms */}
      {listing.terms && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-2">Terms</h2>
          <p className="text-sm text-text-muted whitespace-pre-wrap">{listing.terms}</p>
        </div>
      )}

      {/* Activity stats bar — public */}
      {activity && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
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
        <div className="bg-surface shadow-card border border-border rounded-xl p-5">
          <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 w-fit mb-4">
            {(['bids', 'trades'] as const).map((t) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`px-5 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeTab === t ? 'bg-surface text-primary shadow-card' : 'text-text-muted hover:text-text-primary'}`}>
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
                        <p className="font-semibold text-text-primary">PKR {Number(bid.pricePerUnit).toLocaleString()} / {listing.token.symbol}</p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {bid.bidder.username} · {Number(bid.tokenAmount).toLocaleString()} {listing.token.symbol} · PKR {Number(bid.fiatAmount).toLocaleString()} total
                        </p>
                        {bid.message && <p className="text-xs text-text-muted italic mt-0.5">&ldquo;{bid.message}&rdquo;</p>}
                      </div>
                      <div className="flex gap-2 flex-shrink-0 items-start">
                        {bid.status === 'accepted_pending_buyer' ? (
                          <span className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium">Awaiting buyer</span>
                        ) : (
                          <>
                            <button onClick={() => handleAcceptBid(bid.id)} disabled={bidActionId === bid.id}
                              className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-green-700 disabled:opacity-60 transition-colors">
                              {bidActionId === bid.id ? '…' : 'Accept'}
                            </button>
                            <button onClick={() => handleRejectBid(bid.id)} disabled={bidActionId === bid.id}
                              className="border border-border text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-surface disabled:opacity-60 transition-colors">
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
                    <div key={t.tradeRef} className="flex items-start justify-between gap-3 bg-surface rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-primary">
                          {Number(t.tokenAmount).toLocaleString()} {listing.token.symbol} · PKR {Number(t.fiatAmount).toLocaleString()}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {t.buyer.username} → {t.seller.username} · PKR {Number(t.pricePerUnit).toLocaleString()}/{listing.token.symbol}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          t.status === 'completed'  ? 'bg-green-500/15 text-green-700 dark:text-green-300' :
                          t.status === 'cancelled'  ? 'bg-surface-alt text-text-secondary' :
                          t.status === 'disputed'   ? 'bg-red-500/15 text-red-700 dark:text-red-300' :
                          'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                        }`}>{t.status.replace(/_/g, ' ')}</span>
                        <p className="text-xs text-text-muted mt-1">
                          <a href={`/ctm/trade/${t.tradeRef}`} className="text-primary hover:underline">View →</a>
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
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4">
          <p className="font-semibold text-amber-900 dark:text-amber-200">Your bid was accepted!</p>
          <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
            Complete your payment details to open the trade. The window expires at{' '}
            {new Date(myActiveBid.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          </p>
          <button
            onClick={() => { setShowConfirmBidModal(true); setConfirmPaymentMethodId(''); setConfirmBuyerFromMethodId(''); setConfirmPaymentMethodIds([]); setConfirmBuyerSettlementId(''); setConfirmMessage(''); setConfirmError('') }}
            className="mt-3 bg-amber-600 text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-amber-700 transition-colors"
          >
            Complete Trade Details
          </button>
        </div>
      )}

      {/* CTA */}
      {!isMine && listing.status === 'active' && !myActiveBid && (
        <div className="flex gap-3">
          <button
            onClick={() => { setShowModal(true); setPaymentMethodId(''); setBuyerFromMethodId(''); setPaymentMethodIds([]); setTokenAmount(''); setError('') }}
            className={`flex-1 py-3.5 rounded-xl font-bold text-white transition-colors ${listing.side === 'sell' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {listing.side === 'sell' ? `Buy ${listing.token.symbol}` : `Sell ${listing.token.symbol}`}
          </button>
          <button
            onClick={() => { setShowBidModal(true); setTokenAmount(''); setBidPrice(''); setError('') }}
            className="flex-1 py-3.5 rounded-xl font-bold border-2 border-primary text-primary hover:bg-primary/5 transition-colors"
          >
            Bid
          </button>
        </div>
      )}
      {/* Pending bid notice */}
      {!isMine && myActiveBid?.status === 'pending' && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 text-sm text-blue-800 dark:text-blue-300">
          You have a pending bid on this listing. Waiting for the merchant to respond.
        </div>
      )}

      {/* Trade modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Start Trade</h3>
            {error && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{error}</div>}

            {/* Token-quantity input */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {isBuyListing
                  ? `How many ${listing.token.symbol} will you send to the buyer?`
                  : `How many ${listing.token.symbol} do you want to buy?`}
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={Number(listing.minOrderTokens)}
                  max={Math.min(Number(listing.maxOrderTokens), Number(listing.availableAmount))}
                  step="0.000001"
                  placeholder={`${Number(listing.minOrderTokens).toLocaleString()} – ${Number(listing.maxOrderTokens).toLocaleString()}`}
                  value={tokenAmount}
                  onChange={(e) => setTokenAmount(e.target.value)}
                  className="w-full border border-border rounded-xl pl-3 pr-16 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">{listing.token.symbol}</span>
              </div>
              <p className="text-xs text-text-muted mt-1">
                Min {Number(listing.minOrderTokens).toLocaleString()} · Max {Number(listing.maxOrderTokens).toLocaleString()} {listing.token.symbol}
              </p>
            </div>

            {/* Order summary */}
            {(() => {
              const tokenAmt = tokenAmount ? parseFloat(tokenAmount) : 0
              const price = Number(listing.pricePerUnit)
              const totalPkr = tokenAmt * price
              return (
                <div className="bg-surface rounded-xl border border-border p-4 space-y-2 text-sm">
                  <p className="font-semibold text-text-primary mb-2">Order Summary</p>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Price per {listing.token.symbol}</span>
                    <span className="font-medium text-text-primary">PKR {price.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Token amount</span>
                    <span className="font-medium text-text-primary">{tokenAmt > 0 ? tokenAmt.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'} {listing.token.symbol}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-2 font-semibold">
                    <span className="text-text-muted">{isBuyListing ? 'Total you will receive' : 'Total payable'}</span>
                    <span className="text-text-primary">PKR {totalPkr.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              )
            })()}

            {/* Payment method selection */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-0.5">
                {isBuyListing
                  ? 'Choose where you want to receive payment for this trade'
                  : "Select the seller's payment account you'll send payment to"}
              </label>
              {isBuyListing && (
                <p className="text-xs text-text-muted mb-2">Select all accounts you're happy to receive payment to — buyer will choose one.</p>
              )}
              {isBuyListing && myMethods.length === 0 && (
                <p className="text-xs text-text-muted bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
                  No saved payment accounts found. <a href="/payment-methods" className="text-primary underline">Add one →</a>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {modalPaymentMethods.map((m) => {
                  const isSelected = isBuyListing ? paymentMethodIds.includes(m.id) : paymentMethodId === m.id
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        if (isBuyListing) {
                          setPaymentMethodIds((prev) =>
                            prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                          )
                        } else {
                          setPaymentMethodId(m.id)
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {isBuyListing && isSelected && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* SELL listing: show buyer's own methods so seller knows which account payment will come from */}
            {!isBuyListing && myMethods.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-0.5">
                  Your payment account (you&apos;ll pay from)
                </label>
                <p className="text-xs text-text-muted mb-2">
                  Select which of your accounts you&apos;ll send payment from — this lets the seller know where to expect it.
                </p>
                <div className="flex flex-wrap gap-2">
                  {myMethods.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => setBuyerFromMethodId(prev => prev === m.id ? '' : m.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${buyerFromMethodId === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {buyerFromMethodId === m.id && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* BUY listing: show buyer's receiving address so seller knows where to send tokens */}
            {isBuyListing && listing.settlementMethod && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  Send tokens to buyer&apos;s address
                </label>
                <p className="text-xs font-mono bg-surface border border-border rounded-lg px-3 py-2 break-all text-text-primary">
                  {listing.settlementMethod}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  Send {listing.token.symbol} to this address after the buyer confirms payment.
                </p>
              </div>
            )}

            {/* Buyer's token receiving address — only for SELL listings (buyer receives tokens) */}
            {!isBuyListing && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  {buyerAddressLabel(listing.tokenDeliveryType, listing.token.name)}
                </label>
                {(() => {
                  const matching = savedAddresses.filter((a) => a.network === 'CTM' && a.coin === listing.token.symbol)
                  if (matching.length === 0) return null
                  return (
                    <div className="mb-2">
                      <p className="text-xs text-text-muted mb-1.5">Your saved {listing.token.symbol} addresses — tap to fill:</p>
                      <div className="flex flex-wrap gap-2">
                        {matching.map((a) => (
                          <button key={a.id} type="button" onClick={() => setBuyerSettlementId(a.address)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${buyerSettlementId === a.address ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:border-primary/50'}`}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                <input
                  type={listing.tokenDeliveryType === 'email' ? 'email' : 'text'}
                  placeholder={buyerAddressPlaceholder(listing.tokenDeliveryType, listing.token.symbol)}
                  value={buyerSettlementId}
                  onChange={(e) => setBuyerSettlementId(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="mt-1 text-xs text-text-muted">The seller will send tokens here after your payment is confirmed. <Link href="/wallet#payment-methods" className="text-primary hover:underline">Save an address →</Link></p>
              </div>
            )}

            {/* Transfer instructions */}
            {listing.settlementNote && (
              <div className="bg-surface rounded-xl p-3 text-sm">
                <p className="font-medium text-text-primary mb-1">Instructions from merchant:</p>
                <p className="text-text-muted">{listing.settlementNote}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setShowModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handleStartTrade} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {submitting ? 'Starting…' : 'Start Trade'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bid modal */}
      {showBidModal && listing && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-lg text-text-primary">Place a Bid</h3>
              <p className="text-xs text-text-muted mt-0.5">Offer your own price. The merchant has 30 minutes to accept or reject.</p>
            </div>
            {error && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{error}</div>}

            {/* Bid price */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                Your bid price per {listing.token.symbol} (PKR)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">PKR</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={`Listed at ${Number(listing.pricePerUnit).toLocaleString()}`}
                  value={bidPrice}
                  onChange={(e) => setBidPrice(e.target.value)}
                  className="w-full border border-border rounded-xl pl-12 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <p className="text-xs text-text-muted mt-1">Listed price: PKR {Number(listing.pricePerUnit).toLocaleString()}</p>
            </div>

            {/* Token amount */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {isBuyListing
                  ? `How many ${listing.token.symbol} will you send?`
                  : `How many ${listing.token.symbol} do you want?`}
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={Number(listing.minOrderTokens)}
                  max={Math.min(Number(listing.maxOrderTokens), Number(listing.availableAmount))}
                  step="0.000001"
                  placeholder={`${Number(listing.minOrderTokens).toLocaleString()} – ${Number(listing.maxOrderTokens).toLocaleString()}`}
                  value={tokenAmount}
                  onChange={(e) => setTokenAmount(e.target.value)}
                  className="w-full border border-border rounded-xl pl-3 pr-16 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">{listing.token.symbol}</span>
              </div>
            </div>

            {/* Bid summary */}
            {bidPrice && tokenAmount && (() => {
              const price = parseFloat(bidPrice)
              const amount = parseFloat(tokenAmount)
              const total = price * amount
              return (
                <div className="bg-surface rounded-xl border border-border p-4 space-y-2 text-sm">
                  <p className="font-semibold text-text-primary mb-2">Bid Summary</p>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Your bid price</span>
                    <span className="font-medium text-text-primary">PKR {price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Token amount</span>
                    <span className="font-medium text-text-primary">{amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} {listing.token.symbol}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-2 font-semibold">
                    <span className="text-text-muted">{isBuyListing ? 'Total you will receive' : 'Total payable'}</span>
                    <span className="text-text-primary">PKR {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              )
            })()}

            <p className="text-xs text-text-muted bg-blue-500/10 border border-blue-100 rounded-xl px-3 py-2">
              Payment details and your wallet address will be collected after the merchant accepts your bid.
            </p>

            <div className="flex gap-3">
              <button onClick={() => setShowBidModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handlePlaceBid} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {submitting ? 'Placing…' : 'Place Bid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Bid Details modal — shown after merchant accepts bid */}
      {showConfirmBidModal && listing && myActiveBid && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-lg text-text-primary">Complete Trade Details</h3>
              <p className="text-xs text-text-muted mt-0.5">Your bid was accepted. Provide payment details to open the trade.</p>
            </div>

            {/* Bid recap */}
            <div className="bg-surface rounded-xl border border-border p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Bid price</span>
                <span className="font-medium text-text-primary">PKR {Number(myActiveBid.pricePerUnit).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Amount</span>
                <span className="font-medium text-text-primary">{Number(myActiveBid.tokenAmount).toLocaleString()} {listing.token.symbol}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1 font-semibold">
                <span className="text-text-muted">{isBuyListing ? 'Total you receive' : 'Total payable'}</span>
                <span className="text-text-primary">PKR {Number(myActiveBid.fiatAmount).toLocaleString()}</span>
              </div>
            </div>

            {confirmError && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{confirmError}</div>}

            {/* Payment method selection */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-0.5">
                {isBuyListing ? 'Choose where you want to receive payment' : "Select the seller's payment account you'll send to"}
              </label>
              {isBuyListing && myMethods.length === 0 && (
                <p className="text-xs text-text-muted bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
                  No saved payment accounts. <a href="/payment-methods" className="text-primary underline">Add one →</a>
                </p>
              )}
              <div className="flex flex-wrap gap-2 mt-1.5">
                {modalPaymentMethods.map((m) => {
                  const isSelected = isBuyListing ? confirmPaymentMethodIds.includes(m.id) : confirmPaymentMethodId === m.id
                  return (
                    <button type="button" key={m.id}
                      onClick={() => {
                        if (isBuyListing) {
                          setConfirmPaymentMethodIds((prev) => prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id])
                        } else {
                          setConfirmPaymentMethodId(m.id)
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {isSelected && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* SELL listing: buyer's "pay from" account */}
            {!isBuyListing && myMethods.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Your payment account (you&apos;ll pay from)</label>
                <div className="flex flex-wrap gap-2">
                  {myMethods.map((m) => (
                    <button type="button" key={m.id}
                      onClick={() => setConfirmBuyerFromMethodId(prev => prev === m.id ? '' : m.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${confirmBuyerFromMethodId === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {confirmBuyerFromMethodId === m.id && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* SELL listing: token receiving address */}
            {!isBuyListing && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  {buyerAddressLabel(listing.tokenDeliveryType, listing.token.name)}
                </label>
                {(() => {
                  const matching = savedAddresses.filter((a) => a.network === 'CTM' && a.coin === listing.token.symbol)
                  if (matching.length === 0) return null
                  return (
                    <div className="mb-2">
                      <p className="text-xs text-text-muted mb-1.5">Your saved {listing.token.symbol} addresses — tap to fill:</p>
                      <div className="flex flex-wrap gap-2">
                        {matching.map((a) => (
                          <button key={a.id} type="button" onClick={() => setConfirmBuyerSettlementId(a.address)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${confirmBuyerSettlementId === a.address ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:border-primary/50'}`}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                <input
                  type={listing.tokenDeliveryType === 'email' ? 'email' : 'text'}
                  placeholder={buyerAddressPlaceholder(listing.tokenDeliveryType, listing.token.symbol)}
                  value={confirmBuyerSettlementId}
                  onChange={(e) => setConfirmBuyerSettlementId(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}

            {/* Optional message */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Message to merchant (optional)</label>
              <textarea
                placeholder="e.g. I can transact within 20 minutes"
                value={confirmMessage}
                onChange={(e) => setConfirmMessage(e.target.value)}
                maxLength={300}
                rows={2}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowConfirmBidModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handleConfirmBidDetails} disabled={confirmSubmitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {confirmSubmitting ? 'Opening Trade…' : 'Open Trade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
