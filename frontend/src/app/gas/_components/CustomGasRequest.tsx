'use client'
import { useState } from 'react'
import { gasApi } from '@/lib/api'
import { Spinner } from '@/components/ui/Spinner'

export function CustomGasRequest() {
  const [open, setOpen]           = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')
  const [form, setForm]           = useState({
    blockchainName: '', token: '', amount: '', purpose: '',
    urgency: 'normal', details: '', contactEmail: '',
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.blockchainName || !form.token || !form.purpose) return
    setSubmitting(true); setError('')
    try {
      await gasApi.submitCustomRequest({
        blockchainName: form.blockchainName,
        token:          form.token,
        amount:         form.amount || undefined,
        purpose:        form.purpose,
        urgency:        form.urgency,
        details:        form.details || undefined,
        contactEmail:   form.contactEmail || undefined,
      })
      setSubmitted(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-6">
      {!open && (
        <div className="border border-dashed border-primary/20 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 bg-primary/5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary flex-shrink-0 text-xl">+</div>
            <div>
              <p className="text-sm font-semibold text-text-primary">Can't find your blockchain?</p>
              <p className="text-xs text-text-muted">Request custom gas fee for any blockchain</p>
            </div>
          </div>
          <button onClick={() => setOpen(true)} className="px-4 py-2 rounded-xl border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/10 transition-colors flex-shrink-0">
            Request Custom Gas Fee
          </button>
        </div>
      )}

      {open && (
        <div className="border border-primary/20 rounded-xl overflow-hidden bg-surface shadow-card">
          <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-primary/5 to-blue-50 dark:to-blue-950/20 border-b border-primary/10">
            <p className="text-sm font-bold text-text-primary">Custom Gas Fee Request</p>
            <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-secondary" aria-label="Close">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {submitted ? (
            <div className="p-8 text-center">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <p className="text-base font-bold text-text-primary mb-1">Request Submitted!</p>
              <p className="text-sm text-text-muted">Our team will review and contact you within 24 hours.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { label: 'Blockchain Name *', key: 'blockchainName', placeholder: 'e.g., zkSync, TON, Scroll' },
                { label: 'Token Needed *',    key: 'token',          placeholder: 'e.g., USDT, USDC, ETH'    },
                { label: 'Amount Needed',     key: 'amount',         placeholder: 'e.g., 10 USDT'             },
                { label: 'Contact Email',     key: 'contactEmail',   placeholder: 'your@email.com'             },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-text-secondary mb-1.5">{f.label}</label>
                  <input
                    type={f.key === 'contactEmail' ? 'email' : 'text'}
                    placeholder={f.placeholder}
                    value={(form as Record<string, string>)[f.key]}
                    onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    required={f.key === 'blockchainName' || f.key === 'token'}
                    className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1.5">Purpose *</label>
                <select value={form.purpose} onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))} required
                  className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Select purpose</option>
                  <option value="wallet_activation">Wallet Activation</option>
                  <option value="airdrop_gas">Airdrop Gas Refill</option>
                  <option value="token_transfer">Token Transfer</option>
                  <option value="bridge">Bridge Transaction</option>
                  <option value="nft_mint">NFT Mint</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1.5">Urgency</label>
                <select value={form.urgency} onChange={e => setForm(p => ({ ...p, urgency: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-text-secondary mb-1.5">Additional Details</label>
                <textarea rows={3} maxLength={500} placeholder="Describe your requirements..."
                  value={form.details} onChange={e => setForm(p => ({ ...p, details: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
                <p className="text-right text-xs text-text-muted">{form.details.length}/500</p>
              </div>
              {error && <p className="sm:col-span-2 text-sm text-red-500">{error}</p>}
              <div className="sm:col-span-2 flex gap-3">
                <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border bg-surface text-sm font-semibold text-text-secondary hover:bg-surface-alt">Cancel</button>
                <button type="submit" disabled={submitting || !form.blockchainName || !form.token || !form.purpose}
                  className="flex-1 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                  {submitting ? <Spinner size="sm" /> : 'Submit Request'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
