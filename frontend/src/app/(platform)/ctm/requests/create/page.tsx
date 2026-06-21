'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ctmApi } from '@/lib/api'
import { PaymentMethodPicker } from '@/components/ui/PaymentMethodPicker'
import { TokenSelect } from '@/components/ctm/TokenSelect'

interface CtmToken { id: string; name: string; symbol: string; logoUrl?: string }

export default function CreateRequestPage() {
  const router = useRouter()
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    tokenId: '',
    side: 'buy' as 'buy' | 'sell',
    amount: '',
    targetPricePkr: '',
    paymentMethods: [] as string[],
    note: '',
    expiryHours: 2,
  })

  useEffect(() => {
    ctmApi.getTokens({ limit: 100 }).then((res) => {
      setTokens((res as { tokens: CtmToken[] }).tokens ?? [])
    }).finally(() => setLoading(false))
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.tokenId) { setError('Select a token'); return }
    if (!form.amount || parseFloat(form.amount) <= 0) { setError('Enter a valid amount'); return }
    if (form.paymentMethods.length === 0) { setError('Select at least one payment method'); return }

    setSubmitting(true)
    try {
      await ctmApi.createRequest({
        tokenId: form.tokenId,
        side: form.side,
        amount: parseFloat(form.amount),
        targetPricePkr: form.targetPricePkr ? parseFloat(form.targetPricePkr) : undefined,
        paymentMethods: form.paymentMethods,
        note: form.note || undefined,
        expiryHours: form.expiryHours,
      })
      router.push('/ctm/requests')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to post request')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="max-w-xl mx-auto px-4 py-12 text-center text-text-muted">Loading…</div>

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-6">Post a Request</h1>
      <p className="text-text-muted text-sm mb-6">Describe what you need and let merchants come to you with their best offers.</p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-xl p-3 text-sm">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Token *</label>
          <TokenSelect tokens={tokens} value={form.tokenId} onChange={(id) => setForm((f) => ({ ...f, tokenId: id }))} placeholder="Select a token" />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">I want to *</label>
          <div className="flex gap-3">
            {(['buy', 'sell'] as const).map((s) => (
              <button type="button" key={s} onClick={() => setForm((f) => ({ ...f, side: s }))}
                className={`flex-1 py-2.5 rounded-xl border font-semibold text-sm transition-colors ${form.side === s ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-primary hover:bg-surface'}`}>
                {s === 'buy' ? 'Buy Tokens' : 'Sell Tokens'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Amount (tokens) *</label>
            <input type="number" min="0" step="0.000001" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">Target price/token (PKR)</label>
            <input type="number" min="0" step="0.01" value={form.targetPricePkr} onChange={(e) => setForm((f) => ({ ...f, targetPricePkr: e.target.value }))} placeholder="Optional" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Payment methods *</label>
          <PaymentMethodPicker
            selected={form.paymentMethods}
            onChange={(methods) => setForm((f) => ({ ...f, paymentMethods: methods }))}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Note (optional)</label>
          <textarea rows={2} placeholder="Any special requirements?" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1.5">Request expires in</label>
          <select value={form.expiryHours} onChange={(e) => setForm((f) => ({ ...f, expiryHours: parseInt(e.target.value) }))} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none">
            <option value={1}>1 hour</option>
            <option value={2}>2 hours</option>
            <option value={4}>4 hours</option>
            <option value={8}>8 hours</option>
            <option value={24}>24 hours</option>
          </select>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={() => router.back()} className="flex-1 border border-border py-3 rounded-xl text-sm font-medium text-text-primary hover:bg-surface">Cancel</button>
          <button type="submit" disabled={submitting} className="flex-1 bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary/90 disabled:opacity-60">
            {submitting ? 'Posting…' : 'Post Request'}
          </button>
        </div>
      </form>
    </div>
  )
}
