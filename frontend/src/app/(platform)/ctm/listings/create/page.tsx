'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi, apiRequest, savedTermsApi, walletApi } from '@/lib/api'
import type { SavedTerms, SavedDeliveryAddress } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { SaveAddressInline } from '@/components/ctm/SaveAddressInline'
import { TokenSelect } from '@/components/ctm/TokenSelect'
import { MarketInsightWidget } from '@/components/ctm/MarketInsightWidget'
import { CTM_USDT_METHODS, CTM_USDT_METHOD_KINDS, type UsdtMethodKind } from '@/lib/ctmUsdtMethods'

interface CtmToken { id: string; name: string; symbol: string; logoUrl?: string; settlementType: string; addressExample?: string; addressRegex?: string }

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

const METHOD_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank Transfer',
}

function methodSubline(m: SavedPaymentMethod): string {
  if (m.mobileNumber) return m.mobileNumber
  if (m.ibanNumber) return m.ibanNumber
  if (m.accountNumber) return m.accountNumber
  return m.accountName
}

// USDT-as-payment method metadata now lives in a shared module so the create
// form and the take-trade flow categorise methods identically.
// Only surfaced when /ctm/config reports usdtPaymentEnabled.
const CTM_USDT_METHOD_OPTS = CTM_USDT_METHODS

export default function CreateListingPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
  const [savedAddresses, setSavedAddresses] = useState<SavedDeliveryAddress[]>([])
  const [savedTerms, setSavedTerms] = useState<SavedTerms[]>([])
  const [showSaveTerms, setShowSaveTerms] = useState(false)
  const [termsLabel, setTermsLabel] = useState('')
  const [savingTerms, setSavingTerms] = useState(false)
  const [loadingInit, setLoadingInit] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    tokenId: '',
    side: 'sell' as 'buy' | 'sell',
    pricePerUnit: '',
    totalAmount: '',
    minOrderTokens: '',
    maxOrderTokens: '',
    tokenDeliveryType: '' as 'blockchain' | 'email' | 'username' | '',
    settlementMethod: '',
    paymentMethods: [] as string[],
    tradeWindowMins: 45,
    terms: '',
    proofInstructions: '',
  })

  // USDT-as-payment (gated on /ctm/config → usdtPaymentEnabled). Kept OUT of the
  // main `form` object so nothing USDT-related is ever sent while the feature is
  // off — the create body only includes these when isUsdt is true.
  const [usdtEnabled, setUsdtEnabled] = useState(false)
  const [paymentCurrency, setPaymentCurrency] = useState<'PKR' | 'USDT'>('PKR')
  const [usdtMethods, setUsdtMethods] = useState<string[]>([])
  const [usdtDests, setUsdtDests] = useState<Record<string, string>>({})
  // Which method group (Wallet/Blockchain vs Internal/Exchange) the picker shows.
  // Selections persist across groups — the destination inputs below list every
  // selected method regardless of the active group.
  const [usdtKind, setUsdtKind] = useState<UsdtMethodKind>('wallet')

  useEffect(() => {
    const init = async () => {
      try {
        const [tokensRes, methodsRes, termsRes, addrRes, cfgRes] = await Promise.all([
          ctmApi.getTokens({ limit: 100 }),
          apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods'),
          savedTermsApi.getAll().catch(() => [] as SavedTerms[]),
          walletApi.getSavedAddresses().catch(() => [] as SavedDeliveryAddress[]),
          ctmApi.getCtmConfig().catch(() => ({ usdtPaymentEnabled: false })),
        ])
        setTokens((tokensRes as { tokens: CtmToken[] }).tokens ?? [])
        setSavedMethods(Array.isArray(methodsRes) ? methodsRes : [])
        setSavedTerms(Array.isArray(termsRes) ? termsRes : [])
        setSavedAddresses(Array.isArray(addrRes) ? addrRes : [])
        setUsdtEnabled(!!cfgRes?.usdtPaymentEnabled)
      } finally {
        setLoadingInit(false)
      }
    }
    init()
  }, [])

  const isUsdt = usdtEnabled && paymentCurrency === 'USDT'

  function toggleUsdtMethod(value: string) {
    setUsdtMethods((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  function togglePaymentMethod(id: string) {
    setForm((f) => ({
      ...f,
      paymentMethods: f.paymentMethods.includes(id)
        ? f.paymentMethods.filter((x) => x !== id)
        : [...f.paymentMethods, id],
    }))
  }

  function insertSavedTerms(id: string) {
    const t = savedTerms.find((x) => x.id === id)
    if (t) setForm((f) => ({ ...f, terms: t.body }))
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
      /* non-blocking for listing creation */
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.tokenId) { setError('Please select a token'); return }
    // USDT payment: the PKR payment-method requirement is replaced by USDT method
    // selection (+ a receiving address per method on the sell side).
    if (isUsdt) {
      if (usdtMethods.length === 0) { setError('Select at least one USDT payment method'); return }
      if (form.side === 'sell') {
        const missing = usdtMethods.some((m) => !(usdtDests[m] ?? '').trim())
        if (missing) { setError('Add a USDT receiving address/UID for each selected method'); return }
      }
    } else {
      if (form.side === 'sell' && form.paymentMethods.length === 0) { setError('Select at least one payment method'); return }
      if (form.side === 'buy' && form.paymentMethods.length === 0) { setError('Select at least one account you will pay from'); return }
    }
    if (!form.tokenDeliveryType) { setError('Please select how you will deliver tokens'); return }
    if (form.side === 'buy' && !form.settlementMethod.trim()) {
      setError('Enter your token receiving address so sellers know where to send tokens'); return
    }
    // Validate the receiving address format up-front for blockchain delivery, so an
    // invalid address (e.g. a phone number) can't create the ad. Mirrors the backend
    // guardrail; a malformed/absent pattern fails open (backend re-checks anyway).
    if (form.side === 'buy' && form.tokenDeliveryType === 'blockchain') {
      const tok = tokens.find((t) => t.id === form.tokenId)
      const addr = form.settlementMethod.trim()
      if (tok?.addressRegex) {
        let re: RegExp | null = null
        try { re = new RegExp(tok.addressRegex) } catch { re = null }
        if (re && !re.test(addr)) {
          setError(`That doesn't look like a valid ${tok.symbol} address.${tok.addressExample ? ` Example: ${tok.addressExample}` : ''}`)
          return
        }
      }
    }

    setSubmitting(true)
    try {
      const res = await ctmApi.createListing({
        ...form,
        settlementType: 'MANUAL',
        tokenDeliveryType: form.tokenDeliveryType as 'blockchain' | 'email' | 'username',
        pricePerUnit: parseFloat(form.pricePerUnit),
        totalAmount: parseFloat(form.totalAmount),
        minOrderTokens: parseFloat(form.minOrderTokens),
        maxOrderTokens: parseFloat(form.maxOrderTokens),
        ...(form.side === 'buy' ? { settlementMethod: form.settlementMethod, paymentMethods: form.paymentMethods } : {}),
        // USDT-as-payment fields — only sent when the feature is enabled AND the
        // maker chose USDT, so the PKR path stays byte-identical.
        ...(isUsdt
          ? {
              paymentCurrency: 'USDT' as const,
              usdtPaymentMethods: usdtMethods,
              usdtSettlementDestinations: usdtMethods
                .map((m) => ({ method: m, address: (usdtDests[m] ?? '').trim(), label: m }))
                .filter((d) => d.address),
            }
          : {}),
      })
      router.push(`/ctm/listings/${(res as { id: string }).id}`)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to create listing')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingInit) return <div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>

  if (user?.kycStatus !== 'approved') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-bold text-text-primary mb-3">KYC Required</h1>
        <p className="text-text-muted mb-6">Complete KYC verification to create CTM listings.</p>
        <a href="/kyc" className="bg-primary text-white px-5 py-2.5 rounded-lg font-semibold">Complete KYC</a>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-6">Create Listing</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-xl p-3 text-sm">{error}</div>}

        {/* Token */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Token *</label>
          <TokenSelect tokens={tokens} value={form.tokenId} onChange={(id) => setForm((f) => ({ ...f, tokenId: id }))} placeholder="Select a token" />
        </div>

        {/* Side */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">I want to *</label>
          <div className="flex gap-3">
            {(['sell', 'buy'] as const).map((s) => (
              <button type="button" key={s} onClick={() => setForm((f) => ({ ...f, side: s }))}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.side === s ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}>
                {s === 'sell' ? 'Sell Tokens' : 'Buy Tokens'}
              </button>
            ))}
          </div>
        </div>

        {/* Market insight */}
        {form.tokenId && (() => {
          const tok = tokens.find((t) => t.id === form.tokenId)
          return tok ? (
            <MarketInsightWidget tokenId={form.tokenId} tokenSymbol={tok.symbol} side={form.side} />
          ) : null
        })()}

        {/* Price & Amount */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Price per token (PKR) *</label>
            <input type="number" min="0" step="0.01" value={form.pricePerUnit} onChange={(e) => setForm((f) => ({ ...f, pricePerUnit: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Total amount (tokens) *</label>
            <input type="number" min="0" step="0.000001" value={form.totalAmount} onChange={(e) => setForm((f) => ({ ...f, totalAmount: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
          </div>
        </div>

        {/* Order limits (token quantity) */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Minimum tokens per order *</label>
            <input type="number" min="0" step="0.000001" value={form.minOrderTokens} onChange={(e) => setForm((f) => ({ ...f, minOrderTokens: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
            {form.minOrderTokens && form.pricePerUnit && (
              <p className="mt-1 text-xs text-text-muted">≈ PKR {(parseFloat(form.minOrderTokens) * parseFloat(form.pricePerUnit)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Maximum tokens per order *</label>
            <input type="number" min="0" step="0.000001" value={form.maxOrderTokens} onChange={(e) => setForm((f) => ({ ...f, maxOrderTokens: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
            {form.maxOrderTokens && form.pricePerUnit && (
              <p className="mt-1 text-xs text-text-muted">≈ PKR {(parseFloat(form.maxOrderTokens) * parseFloat(form.pricePerUnit)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
            )}
          </div>
        </div>

        {/* Token delivery method */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-0.5">Token Delivery Method *</label>
          <p className="text-xs text-text-muted mb-2">
            {form.side === 'sell'
              ? 'How will you send tokens to buyers after payment is confirmed?'
              : 'How should sellers send tokens to you?'}
          </p>
          {(() => {
            const isInternal = form.tokenDeliveryType === 'email' || form.tokenDeliveryType === 'username'
            return (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, tokenDeliveryType: 'blockchain', settlementMethod: '' }))}
                    className={`py-2.5 text-xs rounded-xl border font-semibold transition-colors ${form.tokenDeliveryType === 'blockchain' ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}
                  >
                    Wallet / Blockchain
                  </button>
                  <button
                    type="button"
                    // Internal Transfer groups Email + Username — pick a default sub-type
                    // (email) when first selected; the sub-toggle below switches between them.
                    onClick={() => setForm((f) => ({ ...f, tokenDeliveryType: isInternal ? f.tokenDeliveryType : 'email', settlementMethod: isInternal ? f.settlementMethod : '' }))}
                    className={`py-2.5 text-xs rounded-xl border font-semibold transition-colors ${isInternal ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}
                  >
                    Internal Transfer
                  </button>
                </div>

                {/* Internal Transfer sub-type: Email vs Username */}
                {isInternal && (
                  <div className="mt-2">
                    <p className="text-xs text-text-muted mb-1.5">How should tokens reach you?</p>
                    <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
                      {([
                        { value: 'email', label: 'Email' },
                        { value: 'username', label: 'Username' },
                      ] as const).map((s) => (
                        <button
                          type="button"
                          key={s.value}
                          onClick={() => setForm((f) => ({ ...f, tokenDeliveryType: s.value, settlementMethod: '' }))}
                          className={`px-4 py-1.5 text-xs rounded-md font-semibold transition-colors ${form.tokenDeliveryType === s.value ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'}`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )
          })()}

          {/* Only BUY listings need the seller's own receiving address */}
          {form.side === 'buy' && form.tokenDeliveryType && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-text-muted mb-1">
                {form.tokenDeliveryType === 'blockchain' ? 'Your token receiving wallet address' :
                 form.tokenDeliveryType === 'email' ? 'Your email address (where tokens will be sent)' :
                 'Your username on the token platform'}
              </label>
              {/* Tap-to-fill saved addresses (blockchain delivery only) */}
              {form.tokenDeliveryType === 'blockchain' && (() => {
                const tok = tokens.find((t) => t.id === form.tokenId)
                if (!tok) return null
                const matching = savedAddresses.filter((a) => a.network === 'CTM' && a.coin === tok.symbol)
                if (matching.length === 0) return null
                return (
                  <div className="mb-2">
                    <p className="text-xs text-text-muted mb-1.5">Your saved {tok.symbol} addresses — tap to fill:</p>
                    <div className="flex flex-wrap gap-2">
                      {matching.map((a) => (
                        <button key={a.id} type="button" onClick={() => setForm((f) => ({ ...f, settlementMethod: a.address }))}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${form.settlementMethod === a.address ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:border-primary/50'}`}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <input
                type={form.tokenDeliveryType === 'email' ? 'email' : 'text'}
                placeholder={(() => {
                  const tok = tokens.find((t) => t.id === form.tokenId)
                  if (form.tokenDeliveryType === 'blockchain') return tok?.addressExample ? `e.g. ${tok.addressExample}` : '0x… or your token wallet address'
                  if (form.tokenDeliveryType === 'email') return 'you@example.com'
                  return 'Your username'
                })()}
                value={form.settlementMethod}
                onChange={(e) => setForm((f) => ({ ...f, settlementMethod: e.target.value }))}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="mt-1 text-xs text-text-muted">
                Sellers will send tokens here when they take your listing.
                {form.tokenDeliveryType === 'blockchain' && (() => {
                  const tok = tokens.find((t) => t.id === form.tokenId)
                  return tok?.addressExample ? <> Format example: <span className="font-mono">{tok.addressExample}</span></> : null
                })()}
              </p>
              {form.tokenDeliveryType === 'blockchain' && (() => {
                const tok = tokens.find((t) => t.id === form.tokenId)
                if (!tok) return null
                return (
                  <SaveAddressInline address={form.settlementMethod} coin={tok.symbol} saved={savedAddresses} onSaved={(a) => setSavedAddresses((prev) => [a, ...prev])} />
                )
              })()}
            </div>
          )}

          {form.side === 'sell' && form.tokenDeliveryType && (
            <p className="mt-2 text-xs text-primary bg-primary/5 rounded-lg px-3 py-2">
              Buyers will provide their receiving address when they start the trade — you do not need to enter it here.
            </p>
          )}
        </div>

        {/* Payment currency (USDT-as-payment) — only when the feature is live. */}
        {usdtEnabled && (
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Payment currency *</label>
            <div className="flex gap-3">
              {(['PKR', 'USDT'] as const).map((c) => (
                <button type="button" key={c} onClick={() => setPaymentCurrency(c)}
                  className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${paymentCurrency === c ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}>
                  {c === 'PKR' ? 'PKR (bank / wallet)' : 'USDT (crypto)'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* USDT payment methods (blockchain + exchange) — mirrors the USDT market. */}
        {isUsdt && (
          <div>
            <label className="block text-sm font-medium text-text-primary mb-0.5">USDT payment methods *</label>
            <p className="text-xs text-text-muted mb-2">
              {form.side === 'sell'
                ? 'Buyers pay you in USDT via these methods. Add the address/UID where you receive for each.'
                : 'You will pay the seller in USDT via one of these methods.'}
            </p>

            {/* Method type — Wallet/Blockchain vs Internal/Exchange, matching the
                wallet "Add Delivery Address" flow. Selecting a group filters the
                options below; picks in the other group stay selected. */}
            <div className="grid grid-cols-2 gap-2 mb-2">
              {CTM_USDT_METHOD_KINDS.map((k) => {
                const count = usdtMethods.filter((v) => CTM_USDT_METHOD_OPTS.find((o) => o.value === v)?.kind === k.key).length
                return (
                  <button type="button" key={k.key} onClick={() => setUsdtKind(k.key)}
                    className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${usdtKind === k.key ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-surface text-text-primary hover:border-primary/50'}`}>
                    {k.label}{count > 0 ? ` (${count})` : ''}
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap gap-2 mb-2">
              {CTM_USDT_METHOD_OPTS.filter((o) => o.kind === usdtKind).map((o) => {
                const on = usdtMethods.includes(o.value)
                return (
                  <button type="button" key={o.value} onClick={() => toggleUsdtMethod(o.value)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface text-text-secondary hover:bg-surface'}`}>
                    <EntityLogo type={o.kind === 'wallet' ? 'chain' : 'exchange'} slug={o.value} size="xs" className="flex-shrink-0" />
                    {o.label}
                  </button>
                )
              })}
            </div>
            {form.side === 'sell' && usdtMethods.length > 0 && (
              <div className="space-y-2">
                {usdtMethods.map((m) => {
                  const opt = CTM_USDT_METHOD_OPTS.find((o) => o.value === m)
                  return (
                    <input key={m} value={usdtDests[m] ?? ''} onChange={(e) => setUsdtDests((d) => ({ ...d, [m]: e.target.value }))}
                      placeholder={`${opt?.label ?? m} — ${opt?.placeholder ?? 'address / UID'}`}
                      className="w-full border border-border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Payment methods — sell: accounts buyers pay TO; buy: accounts you'll pay FROM.
            Hidden when the listing is priced in USDT (USDT methods replace them). */}
        {!isUsdt && (
        <div>
            <label className="block text-sm font-medium text-text-primary mb-0.5">
              {form.side === 'sell' ? 'Payment methods *' : 'Which account(s) will you pay from? *'}
            </label>
            <p className="text-xs text-text-muted mb-2">
              {form.side === 'sell'
                ? 'Select which of your saved payment accounts buyers can use to pay you.'
                : 'Select the account(s) you will send payment from — the seller sees this in the trade so they know where your payment comes from.'}
            </p>

            {savedMethods.length === 0 ? (
              <div className="border border-border rounded-xl p-4 text-center">
                <p className="text-sm text-text-muted mb-2">No payment methods saved yet.</p>
                <a href="/payment-methods" className="text-sm text-primary font-medium hover:underline">
                  Add payment methods in Wallet →
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {savedMethods.map((m) => {
                  const selected = form.paymentMethods.includes(m.id)
                  const isMobile = m.type !== 'bank_transfer'
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => togglePaymentMethod(m.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${
                        selected ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:bg-surface'
                      }`}
                    >
                      <EntityLogo
                        type={isMobile ? 'payment_method' : 'bank'}
                        slug={isMobile ? (METHOD_LABELS[m.type] ?? m.type) : (m.bankName ?? 'bank')}
                        size="sm"
                        className="flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary">
                          {m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (METHOD_LABELS[m.type] ?? m.type)}
                        </p>
                        <p className="text-xs text-text-muted truncate">{m.accountName} · {methodSubline(m)}</p>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${selected ? 'border-primary bg-primary' : 'border-border'}`}>
                        {selected && <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12"><path d="M10 3L5 8.5 2 5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Buy listing info note — seller provides their receiving account when accepting */}
        {form.side === 'buy' && !isUsdt && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-sm text-blue-800 dark:text-blue-300">
            The seller will provide their payment receiving account when they accept your trade. The account(s) you selected above are shown to them as where your payment will come from.
          </div>
        )}

        {/* Trade window */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Trade window (minutes)</label>
          <select value={form.tradeWindowMins} onChange={(e) => setForm((f) => ({ ...f, tradeWindowMins: parseInt(e.target.value) }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none">
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>

        {/* Terms — saveable & reusable templates (same as USDT marketplace) */}
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
          <textarea rows={3} placeholder="Any additional terms for this listing, e.g. Only transfer from your own account."
            value={form.terms} onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))}
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

        <button type="submit" disabled={submitting} className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-60">
          {submitting ? 'Creating…' : 'Create Listing'}
        </button>
      </form>
    </div>
  )
}
