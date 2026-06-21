'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi, apiRequest } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { TokenSelect } from '@/components/ctm/TokenSelect'
import { MarketInsightWidget } from '@/components/ctm/MarketInsightWidget'

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

export default function CreateListingPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
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
    settlementNote: '',
    paymentMethods: [] as string[],
    tradeWindowMins: 45,
    terms: '',
    proofInstructions: '',
  })

  useEffect(() => {
    const init = async () => {
      try {
        const [tokensRes, methodsRes] = await Promise.all([
          ctmApi.getTokens({ limit: 100 }),
          apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods'),
        ])
        setTokens((tokensRes as { tokens: CtmToken[] }).tokens ?? [])
        setSavedMethods(Array.isArray(methodsRes) ? methodsRes : [])
      } finally {
        setLoadingInit(false)
      }
    }
    init()
  }, [])

  function togglePaymentMethod(id: string) {
    setForm((f) => ({
      ...f,
      paymentMethods: f.paymentMethods.includes(id)
        ? f.paymentMethods.filter((x) => x !== id)
        : [...f.paymentMethods, id],
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.tokenId) { setError('Please select a token'); return }
    if (form.side === 'sell' && form.paymentMethods.length === 0) { setError('Select at least one payment method'); return }
    if (form.side === 'buy' && form.paymentMethods.length === 0) { setError('Select at least one account you will pay from'); return }
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
        settlementNote: form.settlementNote.trim() || undefined,
        settlementType: 'MANUAL',
        tokenDeliveryType: form.tokenDeliveryType as 'blockchain' | 'email' | 'username',
        pricePerUnit: parseFloat(form.pricePerUnit),
        totalAmount: parseFloat(form.totalAmount),
        minOrderTokens: parseFloat(form.minOrderTokens),
        maxOrderTokens: parseFloat(form.maxOrderTokens),
        ...(form.side === 'buy' ? { settlementMethod: form.settlementMethod, paymentMethods: form.paymentMethods } : {}),
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
          <div className="grid grid-cols-3 gap-2">
            {([
              { value: 'blockchain', label: 'Wallet / Blockchain' },
              { value: 'email', label: 'Email' },
              { value: 'username', label: 'Username' },
            ] as const).map((m) => (
              <button
                type="button"
                key={m.value}
                onClick={() => setForm((f) => ({ ...f, tokenDeliveryType: m.value, settlementMethod: '' }))}
                className={`py-2.5 text-xs rounded-xl border font-semibold transition-colors ${form.tokenDeliveryType === m.value ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Only BUY listings need the seller's own receiving address */}
          {form.side === 'buy' && form.tokenDeliveryType && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-text-muted mb-1">
                {form.tokenDeliveryType === 'blockchain' ? 'Your token receiving wallet address' :
                 form.tokenDeliveryType === 'email' ? 'Your email address (where tokens will be sent)' :
                 'Your username on the token platform'}
              </label>
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
            </div>
          )}

          {form.side === 'sell' && form.tokenDeliveryType && (
            <p className="mt-2 text-xs text-primary bg-primary/5 rounded-lg px-3 py-2">
              Buyers will provide their receiving address when they start the trade — you do not need to enter it here.
            </p>
          )}
        </div>

        {/* Transfer instructions */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Transfer instructions (optional)</label>
          <textarea rows={3} placeholder="Step-by-step instructions shown to the buyer at trade start" value={form.settlementNote} onChange={(e) => setForm((f) => ({ ...f, settlementNote: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
        </div>

        {/* Payment methods — sell: accounts buyers pay TO; buy: accounts you'll pay FROM */}
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

        {/* Buy listing info note — seller provides their receiving account when accepting */}
        {form.side === 'buy' && (
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

        {/* Terms */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Terms (optional)</label>
          <textarea rows={2} placeholder="Any additional terms for this listing" value={form.terms} onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
        </div>

        <button type="submit" disabled={submitting} className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-60">
          {submitting ? 'Creating…' : 'Create Listing'}
        </button>
      </form>
    </div>
  )
}
