'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { adsApi, marketplaceApi, apiRequest, savedTermsApi } from '@/lib/api'
import type { CreateAdPayload, UpdateAdPayload, SavedTerms } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'

// ─── Constants ────────────────────────────────────────────────────────────────

const NETWORKS = [
  { value: 'BEP20', label: 'BNB Chain (BEP20)' },
  { value: 'Aptos', label: 'Aptos' },
]

// Delivery is grouped into two kinds: an on-chain wallet transfer (where the
// blockchain network matters) and an off-chain exchange/internal transfer (where
// the network is irrelevant — funds move account-to-account on the same venue).
const WALLET_DELIVERY = 'wallet_blockchain'

const EXCHANGE_OPTIONS = [
  { value: 'Binance', label: 'Binance → Binance' },
  { value: 'OKX', label: 'OKX → OKX' },
  { value: 'Bitget', label: 'Bitget → Bitget' },
  { value: 'Gate', label: 'Gate → Gate' },
  { value: 'MEXC', label: 'MEXC → MEXC' },
]
const EXCHANGE_VALUES = EXCHANGE_OPTIONS.map((o) => o.value)

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
  tokenDeliveryTypes: string[]
  settlementMethod: string
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
  tokenDeliveryTypes: [],
  settlementMethod: '',
  tradeWindow: 15,
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
  // Network only matters for on-chain wallet delivery; exchange/internal transfers
  // move off-chain so no blockchain network applies.
  if (form.tokenDeliveryTypes.includes(WALLET_DELIVERY) && !form.network) e.network = 'Select a network'
  if (form.priceType === 'fixed' && !form.fixedPrice) e.fixedPrice = 'Enter a price'
  if (form.priceType === 'fixed' && form.fixedPrice && parseFloat(form.fixedPrice) <= 0) e.fixedPrice = 'Price must be positive'
  if (!form.minAmount) e.minAmount = 'Enter minimum order'
  if (!form.maxAmount) e.maxAmount = 'Enter maximum order'
  if (form.minAmount && form.maxAmount && parseFloat(form.minAmount) >= parseFloat(form.maxAmount))
    e.maxAmount = 'Max must be greater than min'
  if (!form.availableAmount) e.availableAmount = form.side === 'sell' ? 'Enter total amount' : 'Enter total amount you want to buy'
  if (form.side === 'sell' && form.paymentMethods.length === 0) e.paymentMethods = 'Select at least one payment method'
  if (form.tokenDeliveryTypes.length === 0) e.tokenDeliveryTypes = 'Select at least one delivery method'
  if (form.side === 'buy' && form.tokenDeliveryTypes.length > 0 && !form.settlementMethod.trim())
    e.settlementMethod = 'Enter your receiving address so sellers know where to send USDT'
  return e
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CreateListingPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('edit')
  const { user } = useAuth()

  const [form, setForm] = useState<FormState>(defaultForm)
  // UI-only: whether the "Internal / Exchange Transfer" group is expanded to show
  // the per-exchange checkboxes. Derived from whether any exchange is selected.
  const [exchangeOpen, setExchangeOpen] = useState(false)
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
  // Reusable terms templates the maker has saved; used to insert into the Terms box.
  const [savedTerms, setSavedTerms] = useState<SavedTerms[]>([])
  const [showSaveTerms, setShowSaveTerms] = useState(false)
  const [termsLabel, setTermsLabel] = useState('')
  const [savingTerms, setSavingTerms] = useState(false)
  const [loadingInit, setLoadingInit] = useState(true)
  const [marketRate, setMarketRate] = useState(0)
  const [marketRateSource, setMarketRateSource] = useState('')
  const [rateLoading, setRateLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    const init = async () => {
      const [methodsRes, termsRes] = await Promise.all([
        apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods').catch(() => [] as SavedPaymentMethod[]),
        savedTermsApi.getAll().catch(() => [] as SavedTerms[]),
        editId
          ? adsApi.getAd(editId).then((ad) => {
              const deliveryTypes = ad.tokenDeliveryTypes ?? []
              setExchangeOpen(deliveryTypes.some((v) => EXCHANGE_VALUES.includes(v)))
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
                tokenDeliveryTypes: deliveryTypes,
                settlementMethod: ad.settlementMethod ?? '',
                tradeWindow: ad.tradeWindow ?? 45,
                terms: ad.terms ?? '',
              })
            }).catch(() => {})
          : Promise.resolve(),
      ])
      setSavedMethods(Array.isArray(methodsRes) ? methodsRes : [])
      setSavedTerms(Array.isArray(termsRes) ? termsRes : [])
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

  function insertSavedTerms(id: string) {
    const t = savedTerms.find((x) => x.id === id)
    if (t) set('terms', t.body)
  }

  async function handleSaveTerms() {
    const body = form.terms.trim()
    const label = termsLabel.trim()
    if (!body || !label) return
    setSavingTerms(true)
    try {
      const created = await savedTermsApi.add({ label, body })
      setSavedTerms((prev) => [created, ...prev])
      setShowSaveTerms(false)
      setTermsLabel('')
    } catch {
      /* surfaced via the inline button staying open; non-blocking for ad creation */
    } finally {
      setSavingTerms(false)
    }
  }

  async function handleDeleteSavedTerms(id: string) {
    setSavedTerms((prev) => prev.filter((x) => x.id !== id))
    try {
      await savedTermsApi.remove(id)
    } catch {
      /* best-effort; list refreshes on next load */
    }
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
          ...(form.availableAmount ? { totalAmount: parseFloat(form.availableAmount) } : {}),
          minOrder: parseFloat(form.minAmount),
          maxOrder: parseFloat(form.maxAmount),
          paymentMethods: form.side === 'sell' ? form.paymentMethods : [],
          tokenDeliveryTypes: form.tokenDeliveryTypes,
          ...(form.settlementMethod.trim() ? { settlementMethod: form.settlementMethod.trim() } : {}),
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
        {submitError && <div className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-xl p-3 text-sm">{submitError}</div>}

        {/* Side */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">I want to *</label>
          <div className="flex gap-3">
            {(['sell', 'buy'] as const).map((s) => (
              <button type="button" key={s} onClick={() => set('side', s)}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.side === s ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}>
                {s === 'sell' ? 'Sell USDT' : 'Buy USDT'}
              </button>
            ))}
          </div>
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
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.priceType === pt.value ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}>
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

        {/* Total amount */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">
            {form.side === 'sell' ? 'Total available amount (USDT) *' : 'Total USDT you want to buy *'}
          </label>
          <input type="number" min="0" step="0.000001" value={form.availableAmount} onChange={(e) => set('availableAmount', e.target.value)}
            placeholder={form.side === 'sell' ? 'Total USDT you are offering in this listing' : 'Total USDT you wish to purchase'}
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          {errors.availableAmount && <p className="text-sm text-danger mt-1">{errors.availableAmount}</p>}
        </div>

        {/* Token Delivery Method — two kinds: on-chain wallet (network applies) or
            off-chain exchange/internal transfer (pick one or more venues). */}
        {(() => {
          const walletSelected = form.tokenDeliveryTypes.includes(WALLET_DELIVERY)
          const selectedExchanges = form.tokenDeliveryTypes.filter((v) => EXCHANGE_VALUES.includes(v))
          const toggleWallet = () => setForm((f) => ({
            ...f,
            tokenDeliveryTypes: walletSelected
              ? f.tokenDeliveryTypes.filter((v) => v !== WALLET_DELIVERY)
              : [...f.tokenDeliveryTypes, WALLET_DELIVERY],
            settlementMethod: '',
          }))
          const toggleExchangeGroup = () => {
            if (exchangeOpen) {
              // Collapsing clears any exchange picks so state stays consistent.
              setForm((f) => ({ ...f, tokenDeliveryTypes: f.tokenDeliveryTypes.filter((v) => !EXCHANGE_VALUES.includes(v)), settlementMethod: '' }))
              setExchangeOpen(false)
            } else {
              setExchangeOpen(true)
            }
          }
          const toggleExchange = (val: string) => setForm((f) => {
            const has = f.tokenDeliveryTypes.includes(val)
            return {
              ...f,
              tokenDeliveryTypes: has ? f.tokenDeliveryTypes.filter((v) => v !== val) : [...f.tokenDeliveryTypes, val],
              settlementMethod: '',
            }
          })
          return (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-0.5">Token Delivery Method *</label>
              <p className="text-xs text-text-muted mb-2">
                {form.side === 'sell'
                  ? 'How will you send USDT after payment? Pick one or both.'
                  : 'How should sellers send USDT to you? Pick one or both.'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={toggleWallet}
                  className={`py-2.5 text-sm rounded-xl border font-semibold transition-colors ${walletSelected ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}
                >
                  Wallet / Blockchain
                </button>
                <button
                  type="button"
                  onClick={toggleExchangeGroup}
                  className={`py-2.5 text-sm rounded-xl border font-semibold transition-colors ${exchangeOpen || selectedExchanges.length > 0 ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}
                >
                  Internal / Exchange Transfer
                </button>
              </div>
              {errors.tokenDeliveryTypes && <p className="text-sm text-danger mt-1">{errors.tokenDeliveryTypes}</p>}

              {/* Wallet sub-options: blockchain network (only relevant on-chain) */}
              {walletSelected && (
                <div className="mt-3 rounded-xl border border-border bg-surface-alt/40 p-3">
                  <label className="block text-xs font-medium text-text-primary mb-1.5">Network *</label>
                  <div className="flex flex-wrap gap-2">
                    {NETWORKS.map((n) => (
                      <button type="button" key={n.value} onClick={() => set('network', n.value)}
                        className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${form.network === n.value ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}>
                        {n.label}
                      </button>
                    ))}
                  </div>
                  {errors.network && <p className="text-sm text-danger mt-1">{errors.network}</p>}
                </div>
              )}

              {/* Exchange sub-options: pick the venue(s). Network does not apply —
                  funds move account-to-account on the same exchange. */}
              {exchangeOpen && (
                <div className="mt-3 rounded-xl border border-border bg-surface-alt/40 p-3">
                  <label className="block text-xs font-medium text-text-primary mb-1.5">Select exchange(s)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {EXCHANGE_OPTIONS.map((opt) => {
                      const sel = form.tokenDeliveryTypes.includes(opt.value)
                      return (
                        <button
                          type="button"
                          key={opt.value}
                          onClick={() => toggleExchange(opt.value)}
                          className={`flex items-center gap-2 py-2 px-3 text-sm rounded-lg border font-medium transition-colors ${sel ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-primary hover:bg-surface-alt'}`}
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${sel ? 'border-primary bg-primary' : 'border-border'}`}>
                            {sel && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                          </span>
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-xs text-text-muted">No blockchain network needed — this is an off-chain transfer within the same exchange.</p>
                </div>
              )}

              {/* Buy: receiving address (single field; the lister picks which to use) */}
              {form.side === 'buy' && form.tokenDeliveryTypes.length > 0 && (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-text-muted mb-1">
                    Your receiving address / account — sellers will send USDT here
                  </label>
                  <input
                    type="text"
                    placeholder={walletSelected ? '0x… wallet address' : 'Your exchange UID or deposit address'}
                    value={form.settlementMethod}
                    onChange={(e) => set('settlementMethod', e.target.value)}
                    className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  {errors.settlementMethod && <p className="text-sm text-danger mt-1">{errors.settlementMethod}</p>}
                  <p className="mt-1 text-xs text-text-muted">Sellers will send USDT here when they take your listing.</p>
                </div>
              )}

              {form.side === 'sell' && form.tokenDeliveryTypes.length > 0 && (
                <p className="mt-2 text-xs text-primary bg-primary/5 rounded-lg px-3 py-2">
                  Buyers will pick one of these methods and provide their address at trade start — you do not need to enter it here.
                </p>
              )}
            </div>
          )
        })()}

        {/* Payment methods — sell only */}
        {form.side === 'sell' && (
          <div>
            <label className="block text-sm font-medium text-text-primary mb-0.5">Payment methods *</label>
            <p className="text-xs text-text-muted mb-2">Select which of your saved payment accounts buyers can use to pay you.</p>
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
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:bg-surface-alt'}`}>
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
        )}

        {/* Buy listing info note */}
        {form.side === 'buy' && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-sm text-blue-800 dark:text-blue-300">
            Payment details are not required on a buy listing. The seller will provide their payment receiving account when they accept your trade.
          </div>
        )}

        {/* Trade window */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Trade window</label>
          <select value={form.tradeWindow} onChange={(e) => set('tradeWindow', parseInt(e.target.value))}
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30">
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>

        {/* Terms */}
        <div>
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <label className="block text-sm font-medium text-text-primary">Terms (optional)</label>
            {savedTerms.length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) insertSavedTerms(e.target.value) }}
                className="text-xs border border-border rounded-lg px-2 py-1 bg-surface text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary/30 max-w-[55%]"
              >
                <option value="">Insert saved terms…</option>
                {savedTerms.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            )}
          </div>
          <textarea rows={3}
            placeholder="Any additional terms, e.g. Only transfer from your own account. No third-party payments."
            value={form.terms} onChange={(e) => set('terms', e.target.value)}
            className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />

          {/* Save-as-template control */}
          {form.terms.trim() && !showSaveTerms && (
            <button type="button" onClick={() => setShowSaveTerms(true)}
              className="mt-1.5 text-xs font-medium text-primary hover:underline">
              + Save these terms for reuse
            </button>
          )}
          {showSaveTerms && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={termsLabel}
                onChange={(e) => setTermsLabel(e.target.value)}
                placeholder="Template name (e.g. My standard terms)"
                maxLength={60}
                className="flex-1 border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button type="button" onClick={handleSaveTerms} disabled={savingTerms || !termsLabel.trim()}
                className="px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
                {savingTerms ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => { setShowSaveTerms(false); setTermsLabel('') }}
                className="px-2 py-1.5 text-xs text-text-muted hover:text-text-primary">
                Cancel
              </button>
            </div>
          )}

          {/* Manage saved templates */}
          {savedTerms.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {savedTerms.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-secondary">
                  {t.label}
                  <button type="button" onClick={() => handleDeleteSavedTerms(t.id)}
                    aria-label={`Delete ${t.label}`}
                    className="text-text-muted hover:text-danger leading-none">×</button>
                </span>
              ))}
            </div>
          )}
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
