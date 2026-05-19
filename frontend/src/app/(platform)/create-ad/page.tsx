'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { adsApi, marketplaceApi } from '@/lib/api'
import type { Ad, CreateAdPayload, UpdateAdPayload } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

const SOURCE_LABELS: Record<string, { label: string; url: string }> = {
  coingecko: { label: 'CoinGecko', url: 'https://www.coingecko.com' },
  kraken:    { label: 'Kraken',    url: 'https://www.kraken.com' },
  bybit:     { label: 'Bybit',     url: 'https://www.bybit.com' },
  binance:   { label: 'Binance',   url: 'https://www.binance.com' },
}

function RateSourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source]
  if (!info) return null
  return (
    <a
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[10px] text-text-muted border border-border rounded px-1.5 py-0.5 hover:text-primary transition-colors"
    >
      via {info.label}
    </a>
  )
}

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const NETWORKS = ['BEP20', 'Aptos']

const NETWORK_LABELS: Record<string, string> = {
  BEP20: 'BNB Chain (BEP20)',
  Aptos: 'Aptos',
}

const PAYMENT_METHODS = ['Easypaisa', 'JazzCash', 'Bank Transfer', 'HBL', 'MCB', 'Meezan Bank', 'UBL']

const TRADE_WINDOWS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
]

// â”€â”€â”€ Form State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface FormState {
  type: 'buy' | 'sell'
  coin: string
  network: string
  priceType: 'fixed' | 'float'
  fixedPrice: string
  floatOffset: string
  minAmount: string
  maxAmount: string
  availableAmount: string
  paymentMethods: string[]
  tradeWindow: number
  terms: string
}

const defaultForm: FormState = {
  type: 'buy',
  coin: 'USDT',
  network: 'BEP20',
  priceType: 'fixed',
  fixedPrice: '',
  floatOffset: '0',
  minAmount: '',
  maxAmount: '',
  availableAmount: '',
  paymentMethods: [],
  tradeWindow: 30,
  terms: '',
}

// â”€â”€â”€ Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function validate(form: FormState): Record<string, string> {
  const errs: Record<string, string> = {}
  if (!form.coin) errs.coin = 'Select a coin'
  if (!form.network) errs.network = 'Select a network'
  if (form.priceType === 'fixed' && !form.fixedPrice) errs.fixedPrice = 'Enter a price'
  if (form.priceType === 'fixed' && form.fixedPrice && parseFloat(form.fixedPrice) <= 0) errs.fixedPrice = 'Price must be positive'
  if (!form.minAmount) errs.minAmount = 'Enter minimum amount'
  if (!form.maxAmount) errs.maxAmount = 'Enter maximum amount'
  if (form.minAmount && form.maxAmount && parseFloat(form.minAmount) >= parseFloat(form.maxAmount))
    errs.maxAmount = 'Max must be greater than min'
  if (!form.availableAmount) errs.availableAmount = 'Enter available amount'
  if (form.paymentMethods.length === 0) errs.paymentMethods = 'Select at least one payment method'
  return errs
}

// â”€â”€â”€ Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function CreateAdPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('edit')

  const [form, setForm] = useState<FormState>(defaultForm)
  const [marketRate, setMarketRate] = useState<number>(0)
  const [marketRateSource, setMarketRateSource] = useState<string>('')
  const [rateLoading, setRateLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [loadingEdit, setLoadingEdit] = useState(!!editId)

  // Load existing ad if editing
  useEffect(() => {
    if (!editId) return
    adsApi.getAd(editId)
      .then((ad) => {
        setForm({
          type: ad.side,
          coin: ad.coin,
          network: NETWORKS.includes(ad.network ?? '') ? (ad.network ?? 'BEP20') : 'BEP20',
          priceType: ad.priceType ?? 'fixed',
          fixedPrice: ad.price,
          floatOffset: ad.floatOffset ?? '0',
          minAmount: ad.minOrder,
          maxAmount: ad.maxOrder,
          availableAmount: '',
          paymentMethods: ad.paymentMethods,
          tradeWindow: ad.tradeWindow ?? 30,
          terms: ad.terms ?? '',
        })
      })
      .catch(() => {})
      .finally(() => setLoadingEdit(false))
  }, [editId])

  // Fetch market rate when coin changes
  const fetchRate = useCallback(async (coin: string) => {
    if (!coin) return
    setRateLoading(true)
    try {
      const r = await marketplaceApi.getRate(coin)
      setMarketRate(r.rate)
      setMarketRateSource(r.source ?? '')
    } catch { setMarketRate(0) } finally { setRateLoading(false) }
  }, [])

  useEffect(() => { fetchRate(form.coin) }, [form.coin, fetchRate])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => ({ ...prev, [key]: '' }))
  }

  const togglePaymentMethod = (pm: string) => {
    setForm((prev) => ({
      ...prev,
      paymentMethods: prev.paymentMethods.includes(pm)
        ? prev.paymentMethods.filter((p) => p !== pm)
        : [...prev.paymentMethods, pm],
    }))
    setErrors((prev) => ({ ...prev, paymentMethods: '' }))
  }

  const calculatedPrice =
    marketRate > 0 && form.priceType === 'float'
      ? (marketRate * (1 + parseFloat(form.floatOffset || '0') / 100)).toFixed(2)
      : null

  const handleSubmit = async () => {
    const errs = validate(form)
    if (Object.keys(errs).length > 0) { setErrors(errs); return }

    setSubmitting(true)
    setSubmitError('')

    const price =
      form.priceType === 'fixed'
        ? form.fixedPrice
        : calculatedPrice ?? form.fixedPrice

    const numPrice = parseFloat(price ?? '0')
    const numMin = parseFloat(form.minAmount)
    const numMax = parseFloat(form.maxAmount)
    const numAvailable = parseFloat(form.availableAmount)
    const numOffset = parseFloat(form.floatOffset || '0')

    try {
      if (editId) {
        const updatePayload: UpdateAdPayload = {
          price: numPrice,
          floatOffset: numOffset,
          minOrder: numMin,
          maxOrder: numMax,
          availableAmount: numAvailable,
          paymentMethods: form.paymentMethods,
          tradeWindow: form.tradeWindow,
          terms: form.terms,
        }
        await adsApi.updateAd(editId, updatePayload)
      } else {
        const createPayload: CreateAdPayload = {
          side: form.type,
          coin: form.coin,
          network: form.network,
          priceType: form.priceType,
          price: numPrice,
          floatOffset: numOffset,
          totalAmount: numAvailable,
          minOrder: numMin,
          maxOrder: numMax,
          paymentMethods: form.paymentMethods,
          tradeWindow: form.tradeWindow,
          terms: form.terms,
        }
        await adsApi.createAd(createPayload)
      }
      router.push('/my-ads')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save ad')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingEdit) return <LoadingState message="Loading ad..." />

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">{editId ? 'Edit Ad' : 'Create Ad'}</h1>
        <p className="text-sm text-text-muted">Set up your buy or sell offer</p>
      </div>

      {/* Side Toggle */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-text-primary">I want to</p>
        <div className="grid grid-cols-2 gap-3">
          {(['buy', 'sell'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setField('type', t)}
              className={`py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${
                form.type === t
                  ? t === 'buy'
                    ? 'border-success bg-success/10 text-success'
                    : 'border-danger bg-danger/10 text-danger'
                  : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              {t === 'buy' ? 'Buy USDT' : 'Sell USDT'}
            </button>
          ))}
        </div>
      </div>

      {/* Coin + Network */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-4">
        <p className="text-sm font-semibold text-text-primary">Asset & Network</p>
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">Asset</label>
          <div className="flex items-center gap-2">
            <span className="px-3 py-1.5 rounded-lg border-2 border-primary bg-primary/10 text-primary text-sm font-semibold">
              USDT
            </span>
            <span className="text-xs text-text-muted">Tether USD — only supported stablecoin</span>
          </div>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">Network</label>
          <div className="flex flex-wrap gap-2">
            {NETWORKS.map((n) => (
              <button
                key={n}
                onClick={() => setField('network', n)}
                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                  form.network === n ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:border-primary/40'
                }`}
              >
                {NETWORK_LABELS[n]}
              </button>
            ))}
          </div>
          {errors.network && <p className="text-sm text-danger mt-1">{errors.network}</p>}
        </div>
      </div>

      {/* Price */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-4">
        <p className="text-sm font-semibold text-text-primary">Price</p>
        <div className="grid grid-cols-2 gap-2">
          {(['fixed', 'float'] as const).map((pt) => (
            <button
              key={pt}
              onClick={() => setField('priceType', pt)}
              className={`py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                form.priceType === pt ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              {pt === 'fixed' ? 'Fixed Price' : 'Float (Market %)'}
            </button>
          ))}
        </div>

        {form.priceType === 'fixed' && (
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">Price (PKR per {form.coin})</label>
            <Input
              type="number"
              placeholder={marketRate > 0 ? `Market: ${marketRate.toLocaleString()}` : 'Enter price'}
              value={form.fixedPrice}
              onChange={(e) => setField('fixedPrice', e.target.value)}
            />
            {errors.fixedPrice && <p className="text-sm text-danger mt-1">{errors.fixedPrice}</p>}
          </div>
        )}

        {form.priceType === 'float' && (
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">Offset from market rate (%)</label>
            <Input
              type="number"
              placeholder="e.g. 2 for +2% above market"
              value={form.floatOffset}
              onChange={(e) => setField('floatOffset', e.target.value)}
            />
            <div className="mt-2 bg-surface rounded-lg p-2.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-xs text-text-muted">
                  Market rate: {rateLoading ? '...' : `PKR ${marketRate.toLocaleString()}`}
                </p>
                {!rateLoading && <RateSourceBadge source={marketRateSource} />}
              </div>
              {calculatedPrice && (
                <p className="text-sm font-bold text-text-primary mt-0.5">
                  Your price: PKR {parseFloat(calculatedPrice).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Amounts */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-4">
        <p className="text-sm font-semibold text-text-primary">Amounts</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">Minimum ({form.coin})</label>
            <Input
              type="number"
              placeholder="Min"
              value={form.minAmount}
              onChange={(e) => setField('minAmount', e.target.value)}
            />
            {errors.minAmount && <p className="text-sm text-danger mt-1">{errors.minAmount}</p>}
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">Maximum ({form.coin})</label>
            <Input
              type="number"
              placeholder="Max"
              value={form.maxAmount}
              onChange={(e) => setField('maxAmount', e.target.value)}
            />
            {errors.maxAmount && <p className="text-sm text-danger mt-1">{errors.maxAmount}</p>}
          </div>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">Available Amount ({form.coin})</label>
          <Input
            type="number"
            placeholder="Total amount available to trade"
            value={form.availableAmount}
            onChange={(e) => setField('availableAmount', e.target.value)}
          />
          {errors.availableAmount && <p className="text-sm text-danger mt-1">{errors.availableAmount}</p>}
        </div>
      </div>

      {/* Payment Methods */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-text-primary">Payment Methods</p>
        <div className="flex flex-wrap gap-2">
          {PAYMENT_METHODS.map((pm) => (
            <button
              key={pm}
              onClick={() => togglePaymentMethod(pm)}
              className={`px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${
                form.paymentMethods.includes(pm)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              {pm}
            </button>
          ))}
        </div>
        {errors.paymentMethods && <p className="text-sm text-danger">{errors.paymentMethods}</p>}
      </div>

      {/* Trade Window */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-text-primary">Trade Window</p>
        <div className="grid grid-cols-2 gap-2">
          {TRADE_WINDOWS.map((tw) => (
            <button
              key={tw.value}
              onClick={() => setField('tradeWindow', tw.value)}
              className={`py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                form.tradeWindow === tw.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:border-primary/40'
              }`}
            >
              {tw.label}
            </button>
          ))}
        </div>
      </div>

      {/* Terms */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <p className="text-sm font-semibold text-text-primary">Trade Terms (optional)</p>
        <textarea
          rows={3}
          placeholder="e.g. Only transfer from your own account. No third-party payments."
          value={form.terms}
          onChange={(e) => setField('terms', e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-none"
        />
      </div>

      {submitError && (
        <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">
          {submitError}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={() => router.push('/my-ads')} disabled={submitting}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={handleSubmit} disabled={submitting}>
          {submitting ? <Spinner size="sm" /> : editId ? 'Save Changes' : 'Create Ad'}
        </Button>
      </div>
    </div>
  )
}

export default function CreateAdPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin h-8 w-8 border-2 border-brand-500 border-t-transparent rounded-full" /></div>}>
      <CreateAdPageContent />
    </Suspense>
  )
}

