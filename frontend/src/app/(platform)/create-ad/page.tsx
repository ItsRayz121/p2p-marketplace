'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { adsApi, marketplaceApi, apiRequest } from '@/lib/api'
import type { CreateAdPayload, UpdateAdPayload } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'

// ─── Constants ────────────────────────────────────────────────────────────────

const NETWORKS = [
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
  { value: 'TRC20', label: 'Tron (TRC20)' },
  { value: 'ERC20', label: 'Ethereum (ERC20)' },
  { value: 'Aptos', label: 'Aptos' },
]

const SOURCE_LABELS: Record<string, string> = {
  coingecko: 'CoinGecko', kraken: 'Kraken', bybit: 'Bybit', binance: 'Binance',
}

const METHOD_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank Transfer',
}

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface FormState {
  side: 'buy' | 'sell'
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
  side: 'sell',
  network: 'BEP20',
  priceType: 'fixed',
  fixedPrice: '',
  floatOffset: '0',
  minAmount: '',
  maxAmount: '',
  availableAmount: '',
  paymentMethods: [],
  tradeWindow: 45,
  terms: '',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function methodSubline(m: SavedPaymentMethod): string {
  if (m.mobileNumber) return m.mobileNumber
  if (m.ibanNumber) return m.ibanNumber
  if (m.accountNumber) return m.accountNumber
  return m.accountName
}

function methodLabel(m: SavedPaymentMethod): string {
  return m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (METHOD_LABELS[m.type] ?? m.type)
}

function validate(form: FormState): Record<string, string> {
  const e: Record<string, string> = {}
  if (!form.network) e.network = 'Select a network'
  if (form.priceType === 'fixed' && !form.fixedPrice) e.fixedPrice = 'Enter a price'
  if (form.priceType === 'fixed' && form.fixedPrice && parseFloat(form.fixedPrice) <= 0) e.fixedPrice = 'Price must be positive'
  if (!form.minAmount) e.minAmount = 'Enter minimum order'
  if (!form.maxAmount) e.maxAmount = 'Enter maximum order'
  if (form.minAmount && form.maxAmount && parseFloat(form.minAmount) >= parseFloat(form.maxAmount))
    e.maxAmount = 'Max must be greater than min'
  if (!form.availableAmount) e.availableAmount = 'Enter total amount'
  if (form.paymentMethods.length === 0) e.paymentMethods = 'Select at least one payment method'
  return e
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CreateListingPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('edit')
  const { user } = useAuth()

  const [form, setForm] = useState<FormState>(defaultForm)
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
  const [loadingInit, setLoadingInit] = useState(true)
  const [marketRate, setMarketRate] = useState(0)
  const [marketRateSource, setMarketRateSource] = useState('')
  const [rateLoading, setRateLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Load saved payment methods + existing ad if editing
  useEffect(() => {
    const init = async () => {
      const [methodsRes] = await Promise.all([
        apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods').catch(() => [] as SavedPaymentMethod[]),
        editId
          ? adsApi.getAd(editId).then((ad) => {
              setForm({
                side: ad.side as 'buy' | 'sell',
                network: ad.network ?? 'BEP20',
                priceType: (ad.priceType ?? 'fixed') as 'fixed' | 'float',
                fixedPrice: ad.price,
                floatOffset: ad.floatOffset ?? '0',
                minAmount: ad.minOrder,
                maxAmount: ad.maxOrder,
                availableAmount: '',
                paymentMethods: ad.paymentMethods,
                tradeWindow: ad.tradeWindow ?? 45,
                terms: ad.terms ?? '',
              })
            }).catch(() => {})
          : Promise.resolve(),
      ])
      setSavedMethods(Array.isArray(methodsRes) ? methodsRes : [])
      setLoadingInit(false)
    }
    init()
  }, [editId])

  const fetchRate = useCallback(async () => {
    setRateLoading(true)
    try {
      const r = await marketplaceApi.getRate('USDT')
      setMarketRate(r.rate)
      setMarketRateSource(r.source ?? '')
    } catch { setMarketRate(0) } finally { setRateLoading(false) }
  }, [])

  useEffect(() => { fetchRate() }, [fetchRate])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: '' }))
  }

  function toggleMethod(id: string) {
    set('paymentMethods', form.paymentMethods.includes(id)
      ? form.paymentMethods.filter((x) => x !== id)
      : [...form.paymentMethods, id])
  }

  const calculatedPrice = marketRate > 0 && form.priceType === 'float'
    ? (marketRate * (1 + parseFloat(form.floatOffset || '0') / 100)).toFixed(2)
    : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validate(form)
    if (Object.keys(errs).length > 0) { setErrors(errs); return }
    setSubmitting(true)
    setSubmitError('')

    const price = form.priceType === 'fixed'
      ? parseFloat(form.fixedPrice)
      : parseFloat(calculatedPrice ?? form.fixedPrice)

    try {
      if (editId) {
        const payload: UpdateAdPayload = {
          price,
          floatOffset: parseFloat(form.floatOffset || '0'),
          minOrder: parseFloat(form.minAmount),
          maxOrder: parseFloat(form.maxAmount),
          availableAmount: form.availableAmount ? parseFloat(form.availableAmount) : undefined,
          paymentMethods: form.paymentMethods,
          tradeWindow: form.tradeWindow,
          terms: form.terms,
        }
        await adsApi.updateAd(editId, payload)
      } else {
        const payload: CreateAdPayload = {
          side: form.side,
          coin: 'USDT',
          network: form.network,
          priceType: form.priceType,
          price,
          floatOffset: parseFloat(form.floatOffset || '0'),
          totalAmount: parseFloat(form.availableAmount),
          minOrder: parseFloat(form.minAmount),
          maxOrder: parseFloat(form.maxAmount),
          paymentMethods: form.paymentMethods,
          tradeWindow: form.tradeWindow,
          terms: form.terms,
        }
        await adsApi.createAd(payload)
      }
      router.push('/my-ads')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save listing')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingInit) return <div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>

  if (user?.kycStatus !== 'approved') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-bold text-text-primary mb-3">KYC Required</h1>
        <p className="text-text-muted mb-6">Complete KYC verification to create USDT listings.</p>
        <a href="/kyc" className="bg-primary text-white px-5 py-2.5 rounded-lg font-semibold">Complete KYC</a>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-6">{editId ? 'Edit Listing' : 'Create Listing'}</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {submitError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">{submitError}</div>}

        {/* Side */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">I want to *</label>
          <div className="flex gap-3">
            {(['sell', 'buy'] as const).map((s) => (
              <button type="button" key={s} onClick={() => set('side', s)}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.side === s ? 'border-primary bg-primary text-white' : 'border-border bg-white text-text-primary hover:bg-surface'}`}>
                {s === 'sell' ? 'Sell USDT' : 'Buy USDT'}
              </button>
            ))}
          </div>
        </div>

        {/* Asset & Network */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Asset</label>
          <div className="flex items-center gap-2 mb-4">
            <EntityLogo type="token" slug="USDT" size="sm" />
            <span className="px-3 py-1.5 rounded-lg border-2 border-primary bg-primary/10 text-primary text-sm font-semibold">USDT</span>
            <span className="text-xs text-text-muted">Tether USD — only supported stablecoin</span>
          </div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Network *</label>
          <div className="flex flex-wrap gap-2">
            {NETWORKS.map((n) => (
              <button type="button" key={n.value} onClick={() => set('network', n.value)}
                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${form.network === n.value ? 'border-primary bg-primary text-white' : 'border-border bg-white text-text-primary hover:bg-surface'}`}>
                {n.label}
              </button>
            ))}
          </div>
          {errors.network && <p className="text-sm text-danger mt-1">{errors.network}</p>}
        </div>

        {/* Price */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Price type *</label>
          <div className="flex gap-3 mb-3">
            {([
              { value: 'fixed', label: 'Fixed Price' },
              { value: 'float', label: 'Float (Market %)' },
            ] as const).map((pt) => (
              <button type="button" key={pt.value} onClick={() => set('priceType', pt.value)}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.priceType === pt.value ? 'border-primary bg-primary text-white' : 'border-border bg-white text-text-primary hover:bg-surface'}`}>
                {pt.label}
              </button>
            ))}
          </div>

          {form.priceType === 'fixed' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Price per USDT (PKR) *</label>
              <input type="number" min="0" step="0.01"
                placeholder={marketRate > 0 ? `Market rate: ${marketRate.toLocaleString()}` : 'Enter price'}
                value={form.fixedPrice} onChange={(e) => set('fixedPrice', e.target.value)}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              {errors.fixedPrice && <p className="text-sm text-danger mt-1">{errors.fixedPrice}</p>}
              {marketRate > 0 && (
                <p className="text-xs text-text-muted mt-1">
                  Market rate: PKR {marketRate.toLocaleString()}
                  {marketRateSource ? ` · via ${SOURCE_LABELS[marketRateSource] ?? marketRateSource}` : ''}
                </p>
              )}
            </div>
          )}

          {form.priceType === 'float' && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Offset from market rate (%)</label>
              <input type="number" step="0.01"
                placeholder="e.g. 2 for +2% above market"
                value={form.floatOffset} onChange={(e) => set('floatOffset', e.target.value)}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              <div className="mt-2 bg-surface border border-border rounded-xl p-3 text-sm">
                <p className="text-text-muted">
                  Market rate: {rateLoading ? '…' : `PKR ${marketRate.toLocaleString()}`}
                  {marketRateSource ? ` · via ${SOURCE_LABELS[marketRateSource] ?? marketRateSource}` : ''}
                </p>
                {calculatedPrice && (
                  <p className="font-bold text-text-primary mt-0.5">Your price: PKR {parseFloat(calculatedPrice).toLocaleString()}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Amounts */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Minimum per order (USDT) *</label>
            <input type="number" min="0" step="0.000001" value={form.minAmount} onChange={(e) => set('minAmount', e.target.value)}
              className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            {form.minAmount && form.fixedPrice && (
              <p className="mt-1 text-xs text-text-muted">≈ PKR {(parseFloat(form.minAmount) * parseFloat(form.fixedPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
            )}
            {errors.minAmount && <p className="text-sm text-danger mt-1">{errors.minAmount}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Maximum per order (USDT) *</label>
            <input type="number" min="0" step="0.000001" value={form.maxAmount} onChange={(e) => set('maxAmount', e.target.value)}
              className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            {form.maxAmount && form.fixedPrice && (
              <p className="mt-1 text-xs text-text-muted">≈ PKR {(parseFloat(form.maxAmount) * parseFloat(form.fixedPrice)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
            )}
            {errors.maxAmount && <p className="text-sm text-danger mt-1">{errors.maxAmount}</p>}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Total available amount (USDT) *</label>
          <input type="number" min="0" step="0.000001" value={form.availableAmount} onChange={(e) => set('availableAmount', e.target.value)}
            placeholder="Total amount available to trade in this listing"
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          {errors.availableAmount && <p className="text-sm text-danger mt-1">{errors.availableAmount}</p>}
        </div>

        {/* Payment methods */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-0.5">Payment methods *</label>
          <p className="text-xs text-text-muted mb-2">Select which of your saved payment accounts counterparties can use.</p>
          {errors.paymentMethods && <p className="text-sm text-danger mb-2">{errors.paymentMethods}</p>}

          {savedMethods.length === 0 ? (
            <div className="border border-border rounded-xl p-4 text-center">
              <p className="text-sm text-text-muted mb-2">No payment methods saved yet.</p>
              <a href="/payment-methods" className="text-sm text-primary font-medium hover:underline">Add payment methods in Wallet →</a>
            </div>
          ) : (
            <div className="space-y-2">
              {savedMethods.map((m) => {
                const selected = form.paymentMethods.includes(m.id)
                const isMobile = m.type !== 'bank_transfer'
                return (
                  <button type="button" key={m.id} onClick={() => toggleMethod(m.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-border bg-white hover:bg-surface'}`}>
                    <EntityLogo
                      type={isMobile ? 'payment_method' : 'bank'}
                      slug={isMobile ? (METHOD_LABELS[m.type] ?? m.type) : (m.bankName ?? 'bank')}
                      size="sm"
                      className="flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">{methodLabel(m)}</p>
                      <p className="text-xs text-text-muted truncate">{m.accountName} · {methodSubline(m)}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${selected ? 'border-primary bg-primary' : 'border-border'}`}>
                      {selected && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 12 12">
                          <path d="M2 6l3 3 5-5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Trade window */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Trade window</label>
          <select value={form.tradeWindow} onChange={(e) => set('tradeWindow', parseInt(e.target.value))}
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30">
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>

        {/* Terms */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Terms (optional)</label>
          <textarea rows={3}
            placeholder="Any additional terms, e.g. Only transfer from your own account. No third-party payments."
            value={form.terms} onChange={(e) => set('terms', e.target.value)}
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
        </div>

        <div className="flex gap-3 pt-1">
          <button type="button" onClick={() => router.push('/my-ads')} disabled={submitting}
            className="flex-1 border border-border py-3 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors disabled:opacity-60">
            Cancel
          </button>
          <button type="submit" disabled={submitting}
            className="flex-1 bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-60">
            {submitting ? 'Saving…' : editId ? 'Save Changes' : 'Create Listing'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function CreateListingPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>}>
      <CreateListingPageContent />
    </Suspense>
  )
}
