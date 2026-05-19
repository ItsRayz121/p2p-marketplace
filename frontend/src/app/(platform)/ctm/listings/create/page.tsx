'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

const PAYMENT_METHODS = ['JazzCash', 'Easypaisa', 'SadaPay', 'NayaPay', 'HBL', 'MCB', 'UBL', 'Allied Bank', 'Bank Alfalah', 'Meezan Bank', 'NBP', 'Standard Chartered', 'Askari Bank', 'Faysal Bank', 'JS Bank', 'Bank of Punjab', 'Silk Bank', 'Soneri Bank']

interface CtmToken { id: string; name: string; symbol: string; logoUrl?: string; settlementType: string }

export default function CreateListingPage() {
  const router = useRouter()
  const { user } = useAuthStore()
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [profile, setProfile] = useState<unknown>(null)
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
        const [tokensRes, profileRes] = await Promise.all([
          ctmApi.getTokens({ limit: 100 }),
          ctmApi.getMyCtmProfile().catch(() => null),
        ])
        setTokens((tokensRes as { tokens: CtmToken[] }).tokens ?? [])
        setProfile(profileRes)
      } finally {
        setLoadingInit(false)
      }
    }
    init()
  }, [])

  const togglePayment = (method: string) => {
    setForm((f) => ({
      ...f,
      paymentMethods: f.paymentMethods.includes(method)
        ? f.paymentMethods.filter((m) => m !== method)
        : [...f.paymentMethods, method],
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.tokenId) { setError('Please select a token'); return }
    if (form.paymentMethods.length === 0) { setError('Select at least one payment method'); return }

    setSubmitting(true)
    try {
      const res = await ctmApi.createListing({
        ...form,
        settlementType: 'MANUAL',
        pricePerUnit: parseFloat(form.pricePerUnit),
        totalAmount: parseFloat(form.totalAmount),
        minOrderPkr: parseFloat(form.minOrderPkr),
        maxOrderPkr: parseFloat(form.maxOrderPkr),
      })
      router.push(`/ctm/listings/${(res as { id: string }).id}`)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to create listing')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadingInit) return <div className="max-w-2xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>

  if (!profile) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-xl font-bold text-text-primary mb-3">CTM Merchant Setup Required</h1>
        <p className="text-text-muted mb-6">You need to set up a CTM merchant profile before creating listings.</p>
        <a href="/ctm/merchant-setup" className="bg-primary text-white px-5 py-2.5 rounded-lg font-semibold">Set Up CTM Profile</a>
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

        {/* Settlement */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Settlement method *</label>
          <input type="text" placeholder="e.g. Pi UID, Sidra Account ID" value={form.settlementMethod} onChange={(e) => setForm((f) => ({ ...f, settlementMethod: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Settlement instructions *</label>
          <textarea rows={3} placeholder="Instructions shown to the other party at trade start" value={form.settlementNote} onChange={(e) => setForm((f) => ({ ...f, settlementNote: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" required />
        </div>

        {/* Payment methods */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Payment methods *</label>
          <div className="flex flex-wrap gap-2">
            {PAYMENT_METHODS.map((m) => (
              <button type="button" key={m} onClick={() => togglePayment(m)}
                className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${form.paymentMethods.includes(m) ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-white text-text-primary hover:bg-surface'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Trade window */}
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Trade window (minutes)</label>
          <select value={form.tradeWindowMins} onChange={(e) => setForm((f) => ({ ...f, tradeWindowMins: parseInt(e.target.value) }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>

        {/* Optional fields */}
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
