'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

interface TokenRequest {
  id: string; tokenName: string; tokenSymbol: string; description: string
  officialWebsite?: string; evidenceUrl?: string; status: string; adminNote?: string
  createdAt: string; user: { id: string; username: string; email: string }
}

const SETTLEMENT_TYPES = ['MANUAL', 'ON_CHAIN', 'HYBRID']
const RISK_TIERS = ['low', 'medium', 'high', 'extreme']

export default function AdminTokenQueuePage() {
  const [requests, setRequests] = useState<TokenRequest[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [approveModal, setApproveModal] = useState<TokenRequest | null>(null)
  const [rejectModal, setRejectModal] = useState<TokenRequest | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    slug: '', symbol: '', name: '', description: '', settlementType: 'MANUAL',
    riskTier: 'high', network: '', officialWebsite: '', logoUrl: '',
    maxListingAmount: '', minTradeAmountPkr: '',
  })

  const fetchQueue = async () => {
    try {
      const res = await ctmApi.adminGetTokenQueue({ status: 'pending', page, limit: 20 })
      const data = res as { requests: TokenRequest[]; total: number }
      setRequests(data.requests ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchQueue, 30000)

  const handleApprove = async () => {
    if (!approveModal) return
    setSubmitting(true)
    try {
      await ctmApi.adminApproveTokenRequest(approveModal.id, {
        ...form,
        maxListingAmount: form.maxListingAmount ? parseFloat(form.maxListingAmount) : undefined,
        minTradeAmountPkr: form.minTradeAmountPkr ? parseFloat(form.minTradeAmountPkr) : undefined,
      })
      setApproveModal(null)
      await fetchQueue()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to approve')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (!rejectModal || !rejectNote.trim()) return
    setSubmitting(true)
    try {
      await ctmApi.adminRejectTokenRequest(rejectModal.id, { adminNote: rejectNote })
      setRejectModal(null); setRejectNote('')
      await fetchQueue()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to reject')
    } finally {
      setSubmitting(false)
    }
  }

  const openApprove = (r: TokenRequest) => {
    setForm({ slug: r.tokenSymbol.toLowerCase(), symbol: r.tokenSymbol, name: r.tokenName, description: r.description, settlementType: 'MANUAL', riskTier: 'high', network: '', officialWebsite: r.officialWebsite ?? '', logoUrl: '', maxListingAmount: '', minTradeAmountPkr: '' })
    setApproveModal(r)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">Token Request Queue ({total})</h1>
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No pending token requests.</div>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <div key={r.id} className="bg-white border border-border rounded-xl p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-bold text-text-primary">{r.tokenName} ({r.tokenSymbol})</h3>
                    <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">pending</span>
                  </div>
                  <p className="text-sm text-text-muted mb-2">{r.description}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-text-muted">
                    <span>By: {r.user.username} ({r.user.email})</span>
                    {r.officialWebsite && <a href={r.officialWebsite} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Website</a>}
                    {r.evidenceUrl && <a href={r.evidenceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Evidence</a>}
                    <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => { setRejectModal(r); setRejectNote('') }} className="border border-red-200 text-red-600 text-sm px-3 py-1.5 rounded-lg hover:bg-red-50">Reject</button>
                  <button onClick={() => openApprove(r)} className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-green-700">Approve & Create Token</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={requests.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Approve modal */}
      {approveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 my-4">
            <h3 className="font-bold text-lg text-text-primary">Create Token: {approveModal.tokenName}</h3>
            <div className="grid grid-cols-2 gap-4">
              {[['slug', 'Slug (URL-safe)*'], ['symbol', 'Symbol*'], ['name', 'Name*']].map(([key, label]) => (
                <div key={key} className={key === 'name' ? 'col-span-2' : ''}>
                  <label className="block text-xs font-medium text-text-primary mb-1">{label}</label>
                  <input type="text" value={(form as Record<string, string>)[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none" />
                </div>
              ))}
              <div className="col-span-2">
                <label className="block text-xs font-medium text-text-primary mb-1">Description*</label>
                <textarea rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Settlement Type</label>
                <select value={form.settlementType} onChange={(e) => setForm((f) => ({ ...f, settlementType: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-white focus:outline-none">
                  {SETTLEMENT_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Risk Tier</label>
                <select value={form.riskTier} onChange={(e) => setForm((f) => ({ ...f, riskTier: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm bg-white focus:outline-none">
                  {RISK_TIERS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Network</label>
                <input type="text" value={form.network} onChange={(e) => setForm((f) => ({ ...f, network: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none" placeholder="e.g. Pi Mainnet" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Logo URL</label>
                <input type="url" value={form.logoUrl} onChange={(e) => setForm((f) => ({ ...f, logoUrl: e.target.value }))} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none" />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setApproveModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleApprove} disabled={submitting} className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {submitting ? 'Creating…' : 'Create & Approve'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Reject: {rejectModal.tokenName}</h3>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Admin Note *</label>
              <textarea rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Reason for rejection…" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setRejectModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleReject} disabled={submitting || !rejectNote.trim()} className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {submitting ? 'Rejecting…' : 'Reject Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
