'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { adsApi, tradesApi } from '@/lib/api'
import type { Ad } from '@/lib/api'
import { analytics } from '@/lib/analytics'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

const PAYMENT_METHODS = ['JazzCash', 'Easypaisa', 'Bank Transfer', 'SadaPay', 'NayaPay']

function NewTradePageContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { user } = useAuth()
  const adId = searchParams.get('adId')

  const [ad, setAd] = useState<Ad | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [amount, setAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [deliveryMethod, setDeliveryMethod] = useState<'blockchain' | 'email' | 'username' | ''>('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)

  const fetchAd = useCallback(async () => {
    if (!adId) {
      setError('No ad selected. Please browse the marketplace.')
      setLoading(false)
      return
    }
    try {
      const data = await adsApi.getAd(adId)
      setAd(data)
      if (data.paymentMethods.length > 0) setPaymentMethod(data.paymentMethods[0])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ad')
    } finally {
      setLoading(false)
    }
  }, [adId])

  useEffect(() => { fetchAd() }, [fetchAd])

  const validateAmount = (val: string): string | null => {
    const num = parseFloat(val)
    if (!val || isNaN(num)) return 'Enter an amount'
    if (!ad) return null
    const min = parseFloat(ad.minOrder)
    const max = parseFloat(ad.maxOrder)
    if (num < min) return `Minimum is ${min} ${ad.coin}`
    if (num > max) return `Maximum is ${max} ${ad.coin}`
    const dailyRemaining = (user?.dailyBuyLimit ?? 0) - (user?.dailyBuyUsed ?? 0)
    const pkrAmount = num * parseFloat(ad.price)
    if (dailyRemaining > 0 && pkrAmount > dailyRemaining) {
      return `Exceeds daily limit (PKR ${dailyRemaining.toLocaleString()} remaining)`
    }
    return null
  }

  const handleAmountChange = (val: string) => {
    setAmount(val)
    setAmountError(validateAmount(val))
  }

  const deliveryLabel = (method: string) => {
    if (method === 'blockchain') return 'Wallet Address'
    if (method === 'email') return 'Email Address'
    if (method === 'username') return 'Username'
    return 'Delivery Address'
  }

  const deliveryPlaceholder = (method: string) => {
    if (method === 'blockchain') return '0x... or your wallet address'
    if (method === 'email') return 'you@example.com'
    if (method === 'username') return 'Your username on the platform'
    return ''
  }

  const handleSubmit = async () => {
    if (!ad || !amount || !paymentMethod) return
    const err = validateAmount(amount)
    if (err) { setAmountError(err); return }

    if (!deliveryMethod) { setSubmitError('Please select how you want to receive the tokens'); return }
    if (!deliveryAddress.trim()) { setSubmitError('Please enter your receiving address'); return }

    setSubmitting(true)
    setSubmitError(null)
    try {
      const trade = await tradesApi.createTrade({
        adId: ad.id,
        amount,
        paymentMethod,
        buyerDeliveryMethod: deliveryMethod,
        buyerDeliveryAddress: deliveryAddress.trim(),
      })
      analytics.tradeInitiated({
        tradeId: trade.id,
        coin: ad.coin,
        amount: parseFloat(amount),
        side: ad.side === 'sell' ? 'buy' : 'sell',
      })
      router.push(`/trade/${trade.id}`)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to create trade')
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingState message="Loading offer details..." />
  if (error || !ad) return <ErrorState title={error ?? 'Ad not found'} onRetry={fetchAd} />

  const pkrAmount = amount && !isNaN(parseFloat(amount))
    ? (parseFloat(amount) * parseFloat(ad.price)).toLocaleString(undefined, { maximumFractionDigits: 2 })
    : '—'

  const availableMethods = ad.paymentMethods.length > 0 ? ad.paymentMethods : PAYMENT_METHODS

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">
          {ad.side === 'sell' ? 'Buy' : 'Sell'} {ad.coin}
        </h1>
        <p className="text-sm text-text-muted mt-1">Review the offer and enter the amount to trade</p>
      </div>

      {/* Offer details card */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center">
              {(ad.user?.username || 'U').charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">{ad.user?.username || 'Anonymous'}</p>
              <Badge variant="success" size="sm">Active</Badge>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-text-primary">PKR {Number(ad.price).toLocaleString()}</p>
            <p className="text-xs text-text-muted">per {ad.coin}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="bg-surface rounded-lg p-3">
            <p className="text-xs text-text-muted mb-0.5">Min Amount</p>
            <p className="font-medium text-text-primary">{Number(ad.minOrder).toLocaleString()} {ad.coin}</p>
          </div>
          <div className="bg-surface rounded-lg p-3">
            <p className="text-xs text-text-muted mb-0.5">Max Amount</p>
            <p className="font-medium text-text-primary">{Number(ad.maxOrder).toLocaleString()} {ad.coin}</p>
          </div>
        </div>

        {ad.terms && (
          <div className="mt-3 text-xs text-text-muted bg-surface rounded-lg p-3">
            <span className="font-medium text-text-secondary">Terms: </span>{ad.terms}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-1">
          {(ad.paymentMethods ?? []).map((pm) => (
            <Badge key={pm} variant="default" size="sm">
              <EntityLogo
                type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'}
                slug={pm}
                size="xs"
                className="flex-shrink-0 mr-1"
              />
              {pm}
            </Badge>
          ))}
        </div>
      </div>

      {/* Trade form */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-5">
        {/* Amount input */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">
            Amount ({ad.coin})
          </label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              placeholder={`${ad.minOrder} – ${ad.maxOrder}`}
              className={`w-full px-4 py-3 border rounded-lg text-sm focus:outline-none focus:ring-2 bg-surface ${
                amountError ? 'border-danger focus:ring-danger/30' : 'border-border focus:ring-primary'
              }`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted font-medium">{ad.coin}</span>
          </div>
          {amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
        </div>

        {/* PKR equivalent */}
        <div className="bg-surface rounded-lg px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-text-muted">You will pay</span>
          <span className="text-lg font-bold text-text-primary">PKR {pkrAmount}</span>
        </div>

        {/* Payment method */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">Payment Method</label>
          <div className="grid grid-cols-2 gap-2">
            {availableMethods.map((pm) => (
              <button
                key={pm}
                type="button"
                onClick={() => setPaymentMethod(pm)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm rounded-lg border transition-colors ${
                  paymentMethod === pm
                    ? 'bg-primary/10 border-primary text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-primary/40 bg-surface'
                }`}
              >
                <EntityLogo
                  type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'}
                  slug={pm}
                  size="xs"
                  className="flex-shrink-0"
                />
                {pm}
              </button>
            ))}
          </div>
        </div>

        {/* Token delivery method */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-2">
            How will you receive {ad.coin}?
          </label>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {(['blockchain', 'email', 'username'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setDeliveryMethod(m); setDeliveryAddress('') }}
                className={`px-2 py-2.5 text-xs rounded-lg border transition-colors ${
                  deliveryMethod === m
                    ? 'bg-primary/10 border-primary text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-primary/40 bg-surface'
                }`}
              >
                {m === 'blockchain' ? 'Wallet Address' : m === 'email' ? 'Email' : 'Username'}
              </button>
            ))}
          </div>
          {deliveryMethod && (
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">
                {deliveryLabel(deliveryMethod)}
              </label>
              <input
                type={deliveryMethod === 'email' ? 'email' : 'text'}
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder={deliveryPlaceholder(deliveryMethod)}
                className="w-full px-3 py-2.5 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
              />
              <p className="mt-1 text-xs text-text-muted">
                The seller will send {ad.coin} to this address after confirming your payment.
              </p>
            </div>
          )}
        </div>

        {submitError && (
          <div className="bg-danger/10 border border-danger/20 rounded-lg px-4 py-3 text-sm text-danger">
            {submitError}
          </div>
        )}

        <Button
          fullWidth
          size="lg"
          loading={submitting}
          disabled={!amount || !paymentMethod || !!amountError || !deliveryMethod || !deliveryAddress.trim()}
          onClick={handleSubmit}
        >
          Start Trade
        </Button>

        <p className="text-xs text-text-muted text-center">
          By continuing you agree to release funds only after confirming payment receipt.
        </p>
      </div>
    </div>
  )
}

export default function NewTradePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin h-8 w-8 border-2 border-brand-500 border-t-transparent rounded-full" /></div>}>
      <NewTradePageContent />
    </Suspense>
  )
}
