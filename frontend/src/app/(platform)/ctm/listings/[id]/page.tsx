'use client'
import { useState, use, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi, apiRequest, ApiError } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useAuth } from '@/hooks/useAuth'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

const TIER_COLORS: Record<string, string> = { new: 'bg-gray-100 text-gray-700', basic: 'bg-blue-100 text-blue-700', verified: 'bg-green-100 text-green-700', elite: 'bg-purple-100 text-purple-700' }

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
  merchantProfile: { id: string; tier: string; totalCtmTrades: number; completedCtmTrades: number; ctmAvgRating: string; user: { id: string; username: string } }
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
  const [bidMessage, setBidMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Seller's own payment methods — needed when taking a BUY listing
  const [myMethods, setMyMethods] = useState<ResolvedPaymentMethod[]>([])

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
    if (isBuyListing && paymentMethodIds.length === 0) { setError('Select at least one payment receiving account'); return }
    if (!isBuyListing && !paymentMethodId) { setError('Select a payment method'); return }
    if (!isBuyListing && !buyerSettlementId.trim()) { setError('Enter your token receiving address'); return }
    setError('')
    setSubmitting(true)
    try {
      await ctmApi.placeListingBid(id, {
        pricePerUnit: parseFloat(bidPrice),
        tokenAmount: parseFloat(tokenAmount),
        message: bidMessage.trim() || undefined,
        paymentMethod: isBuyListing ? undefined : paymentMethodId,
        paymentMethods: isBuyListing ? paymentMethodIds : undefined,
        buyerSettlementId: !isBuyListing ? (buyerSettlementId.trim() || undefined) : undefined,
        buyerPaymentMethodId: !isBuyListing && buyerFromMethodId ? buyerFromMethodId : undefined,
      })
      setShowBidModal(false)
      alert('Bid placed! The merchant will be notified.')
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

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-12 animate-pulse"><div className="bg-white rounded-xl h-64 border border-border" /></div>
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
      <div className="bg-white border border-border rounded-xl p-6">
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
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${listing.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{listing.status}</span>
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

      {/* Payment / receiving info section */}
      {isBuyListing ? (
        // BUY listing: lister is BUYER — most important info is buyer's token receiving address
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-1">
            {isMine ? 'Your Token Receiving Address' : "Buyer's Token Receiving Address"}
          </h2>
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
      ) : (
        // SELL listing: lister is SELLER — show their accepted payment methods
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-1">
            {isMine ? 'Your Accepted Payment Methods' : 'Seller Accepted Payment Methods'}
          </h2>
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

      {/* Delivery method */}
      {listing.tokenDeliveryType && (
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-1">Token Delivery Method</h2>
          <p className="text-sm text-text-muted">
            {listing.side === 'sell'
              ? isMine
                ? `You will send tokens to the buyer via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
                : `Seller will send tokens to you via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
              : isMine
                ? `Sellers will send tokens to your address via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`
                : `Send tokens to the buyer's address via ${DELIVERY_LABELS[listing.tokenDeliveryType] ?? listing.tokenDeliveryType}`}
          </p>
        </div>
      )}

      {/* Terms */}
      {listing.terms && (
        <div className="bg-white border border-border rounded-xl p-5">
          <h2 className="font-semibold text-text-primary mb-2">Terms</h2>
          <p className="text-sm text-text-muted whitespace-pre-wrap">{listing.terms}</p>
        </div>
      )}

      {/* CTA */}
      {!isMine && listing.status === 'active' && (
        <div className="flex gap-3">
          <button
            onClick={() => { setShowModal(true); setPaymentMethodId(''); setBuyerFromMethodId(''); setPaymentMethodIds([]); setTokenAmount(''); setError('') }}
            className={`flex-1 py-3.5 rounded-xl font-bold text-white transition-colors ${listing.side === 'sell' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {listing.side === 'sell' ? `Buy ${listing.token.symbol}` : `Sell ${listing.token.symbol}`}
          </button>
          <button
            onClick={() => { setShowBidModal(true); setPaymentMethodId(''); setBuyerFromMethodId(''); setPaymentMethodIds([]); setTokenAmount(''); setBidPrice(''); setBidMessage(''); setError('') }}
            className="flex-1 py-3.5 rounded-xl font-bold border-2 border-primary text-primary hover:bg-primary/5 transition-colors"
          >
            Bid
          </button>
        </div>
      )}

      {/* Trade modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Start Trade</h3>
            {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

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
                <p className="text-xs text-text-muted bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${buyerFromMethodId === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}
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
                <input
                  type={listing.tokenDeliveryType === 'email' ? 'email' : 'text'}
                  placeholder={buyerAddressPlaceholder(listing.tokenDeliveryType, listing.token.symbol)}
                  value={buyerSettlementId}
                  onChange={(e) => setBuyerSettlementId(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="mt-1 text-xs text-text-muted">The seller will send tokens here after your payment is confirmed.</p>
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
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-lg text-text-primary">Place a Bid</h3>
              <p className="text-xs text-text-muted mt-0.5">Offer your own price. The merchant has 30 minutes to accept or reject.</p>
            </div>
            {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

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

            {/* Payment method selection */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-0.5">
                {isBuyListing
                  ? 'Choose where you want to receive payment'
                  : "Select the seller's payment account you'll send to"}
              </label>
              {isBuyListing && (
                <p className="text-xs text-text-muted mb-2">Select all accounts you're happy to receive payment to.</p>
              )}
              {isBuyListing && myMethods.length === 0 && (
                <p className="text-xs text-text-muted bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                  No saved payment accounts. <a href="/payment-methods" className="text-primary underline">Add one →</a>
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
                          setPaymentMethodIds((prev) => prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id])
                        } else {
                          setPaymentMethodId(m.id)
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {isBuyListing && isSelected && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* SELL listing: buyer pays from */}
            {!isBuyListing && myMethods.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-0.5">Your payment account (you&apos;ll pay from)</label>
                <div className="flex flex-wrap gap-2">
                  {myMethods.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => setBuyerFromMethodId(prev => prev === m.id ? '' : m.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${buyerFromMethodId === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary'}`}
                    >
                      <EntityLogo type={m.type === 'bank_transfer' ? 'bank' : 'payment_method'} slug={m.label} size="xs" className="flex-shrink-0" />
                      {m.label}
                      {buyerFromMethodId === m.id && <span className="ml-0.5 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* SELL listing: buyer's token receiving address */}
            {!isBuyListing && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">
                  {buyerAddressLabel(listing.tokenDeliveryType, listing.token.name)}
                </label>
                <input
                  type={listing.tokenDeliveryType === 'email' ? 'email' : 'text'}
                  placeholder={buyerAddressPlaceholder(listing.tokenDeliveryType, listing.token.symbol)}
                  value={buyerSettlementId}
                  onChange={(e) => setBuyerSettlementId(e.target.value)}
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}

            {/* Optional message */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Message to merchant (optional)</label>
              <textarea
                placeholder="e.g. I can transact within 20 minutes"
                value={bidMessage}
                onChange={(e) => setBidMessage(e.target.value)}
                maxLength={300}
                rows={2}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowBidModal(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">Cancel</button>
              <button onClick={handlePlaceBid} disabled={submitting} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {submitting ? 'Placing…' : 'Place Bid'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
