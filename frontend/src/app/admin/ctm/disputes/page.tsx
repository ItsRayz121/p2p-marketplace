'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

interface Dispute {
  id: string; reason: string; description: string; status: string
  openedById: string; escalatedAt?: string; createdAt: string; resolution?: string; winner?: string
  trade: { id: string; tradeRef: string; tokenId: string; fiatAmount: string; buyerId: string; sellerId: string; status: string; proofs: Array<{ fileUrl?: string; proofType: string; uploadedBy: string; createdAt: string }> }
}

export default function AdminCtmDisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Dispute | null>(null)
  const [winner, setWinner] = useState<'buyer' | 'seller' | 'split'>('buyer')
  const [resolution, setResolution] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [statusFilter, setStatusFilter] = useState('open')

  const fetchDisputes = async () => {
    try {
      const res = await fetch(`/api/v1/ctm/trades/admin/all?status=disputed&limit=50`, { credentials: 'include' })
      const data = await res.json()
      // Extract disputes from trade data
      const trades = data.data?.trades ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = trades.filter((t: any) => t.dispute).map((t: any) => ({ ...t.dispute, trade: t }))
      setDisputes(d)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchDisputes, 30000)

  const hoursAgo = (date: string) => {
    const h = Math.floor((Date.now() - new Date(date).getTime()) / 3600000)
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
  }

  const isEscalating = (d: Dispute) => {
    const h = (Date.now() - new Date(d.createdAt).getTime()) / 3600000
    return h > 36 && d.status === 'open'
  }

  const handleResolve = async () => {
    if (!selected || !resolution.trim()) return
    setSubmitting(true)
    try {
      await ctmApi.adminResolveDispute(selected.trade.tradeRef, { winner, resolution })
      setSelected(null); setResolution('')
      await fetchDisputes()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to resolve dispute')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary">CTM Disputes ({disputes.length})</h1>
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : disputes.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No open disputes.</div>
      ) : (
        <div className="space-y-3">
          {disputes
            .sort((a, b) => (isEscalating(b) ? 1 : 0) - (isEscalating(a) ? 1 : 0))
            .map((d) => (
              <div key={d.id} className={`bg-white border rounded-xl p-4 ${isEscalating(d) ? 'border-red-300 bg-red-50/30' : 'border-border'}`}>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-semibold text-text-primary">#{d.trade.tradeRef.slice(-8)}</p>
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{d.reason.replace(/_/g, ' ')}</span>
                      {isEscalating(d) && <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded-full animate-pulse">⚠ Escalating</span>}
                    </div>
                    <p className="text-sm text-text-muted line-clamp-2">{d.description}</p>
                    <p className="text-xs text-text-muted mt-1">Opened {hoursAgo(d.createdAt)} · PKR {Number(d.trade.fiatAmount).toLocaleString()}</p>
                  </div>
                  <button onClick={() => { setSelected(d); setWinner('buyer'); setResolution('') }} className="bg-primary text-white text-sm px-4 py-2 rounded-lg hover:bg-primary/90 flex-shrink-0">Resolve</button>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Resolve modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-5 my-4">
            <h3 className="font-bold text-lg text-text-primary">Resolve Dispute — #{selected.trade.tradeRef.slice(-8)}</h3>

            <div className="bg-surface rounded-xl p-4 text-sm space-y-1">
              <p className="font-medium text-text-primary">{selected.reason.replace(/_/g, ' ')}</p>
              <p className="text-text-muted">{selected.description}</p>
            </div>

            {/* Proofs */}
            {selected.trade.proofs?.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-primary">Evidence</p>
                <div className="grid grid-cols-2 gap-2">
                  {selected.trade.proofs.map((p, i) => (
                    p.fileUrl ? (
                      <a key={i} href={p.fileUrl} target="_blank" rel="noopener noreferrer">
                        <img src={p.fileUrl} alt="proof" className="w-full h-32 object-cover rounded-xl border border-border" />
                        <p className="text-xs text-text-muted mt-1">{p.proofType} · {new Date(p.createdAt).toLocaleDateString()}</p>
                      </a>
                    ) : null
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Winner</label>
              <div className="flex gap-2">
                {(['buyer', 'seller', 'split'] as const).map((w) => (
                  <button key={w} type="button" onClick={() => setWinner(w)}
                    className={`flex-1 py-2 rounded-xl border text-sm font-medium transition-colors ${winner === w ? 'border-primary bg-primary text-white' : 'border-border text-text-primary hover:bg-surface'}`}>
                    {w.charAt(0).toUpperCase() + w.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Resolution Note *</label>
              <textarea rows={4} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Explain the resolution decision…" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleResolve} disabled={submitting || !resolution.trim()} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {submitting ? 'Resolving…' : 'Resolve Dispute'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
