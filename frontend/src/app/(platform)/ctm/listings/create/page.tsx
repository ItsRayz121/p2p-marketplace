'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi, apiRequest } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface CtmToken { id: string; name: string; symbol: string; logoUrl?: string; settlementType: string }

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
  const { user } = useAuthStore()
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
    minOrderPkr: '',
    maxOrderPkr: '',
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
          apiRequest<{ paymentMethods: SavedPaymentMethod[] }>('/wallet/payment-methods'),
        ])
        setTokens((tokensRes as { tokens: CtmToken[] }).tokens ?? [])
        setSavedMethods(methodsRes.paymentMethods ?? [])
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
    if (form.paymentMethods.length === 0) { setError('Select at least one payment method'); return }
    if (!form.tokenDeliveryType) { setError('Please select how you will deliver tokens'); return }
    if (form.side === 'buy' && !form.settlementMethod.trim()) {
      setError('Enter your token receiving address so sellers know where to send tokens'); return
    }

    setSubmitting(true)
    try {
      const res = await ctmApi.createListing({
        ...form,
        settlementType: 'MANUAL',
        tokenDeliveryType: form.tokenDeliveryType as 'blockchain' | 'email' | 'username',
        pricePerUnit: parseFloat(form.pricePerUnit),
        totalAmount: parseFloat(form.totalAmount),
        minOrderPkr: parseFloat(form.minOrderPkr),
        maxOrderPkr: parseFloat(form.maxOrderPkr),
        ...(form.side === 'buy' ? { settlementMethod: form.settlementMethod } : {}),
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
        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">{error}</div>}

        {/* Token */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Token *</label>
          <select value={form.tokenId} onChange={(e) => setForm((f) => ({ ...f, tokenId: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30" required>
            <option value="">Select a token</option>
            {tokens.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.symbol})</option>)}
          </select>
        </div>

        {/* Side */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">I want to *</label>
          <div className="flex gap-3">
            {(['sell', 'buy'] as const).map((s) => (
              <button type="button" key={s} onClick={() => setForm((f) => ({ ...f, side: s }))}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.side === s ? 'border-primary bg-primary text-white' : 'border-border bg-white text-text-primary hover:bg-surface'}`}>
                {s === 'sell' ? 'Sell Tokens' : 'Buy Tokens'}
              </button>
            ))}
          </div>
        </div>

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

        {/* Order limits */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Min order (PKR) *</label>
            <input type="number" min="0" value={form.minOrderPkr} onChange={(e) => setForm((f) => ({ ...f, minOrderPkr: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Max order (PKR) *</label>
            <input type="number" min="0" value={form.maxOrderPkr} onChange={(e) => setForm((f) => ({ ...f, maxOrderPkr: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
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
                className={`py-2.5 text-xs rounded-xl border font-semibold transition-colors ${form.tokenDeliveryType === m.value ? 'border-primary bg-primary text-white' : 'border-border bg-white text-text-primary hover:bg-surface'}`}
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
                placeholder={
                  form.tokenDeliveryType === 'blockchain' ? '0x… or your token wallet address' :
                  form.tokenDeliveryType === 'email' ? 'you@example.com' :
                  'Your username'
                }
                value={form.settlementMethod}
                onChange={(e) => setForm((f) => ({ ...f, settlementMethod: e.target.value }))}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="mt-1 text-xs text-text-muted">Sellers will send tokens here when they take your listing.</p>
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
          <label className="block text-sm font-medium text-text-primary mb-1.5">Transfer instructions *</label>
          <textarea rows={3} placeholder="Step-by-step instructions shown to the buyer at trade start" value={form.settlementNote} onChange={(e) => setForm((f) => ({ ...f, settlementNote: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" required />
        </div>

        {/* Payment methods — from wallet only */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-0.5">Payment methods *</label>
          <p className="text-xs text-text-muted mb-2">Select which of your saved payment accounts buyers can use.</p>

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
                      selected ? 'border-primary bg-primary/5' : 'border-border bg-white hover:bg-surface'
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

        {/* Trade window */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Trade window (minutes)</label>
          <select value={form.tradeWindowMins} onChange={(e) => setForm((f) => ({ ...f, tradeWindowMins: parseInt(e.target.value) }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
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
