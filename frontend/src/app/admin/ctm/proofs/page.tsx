'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Modal } from '@/components/ui/Modal'

interface CtmProof {
  id: string; tradeId: string; proofType: string; fileUrl?: string; fileHash?: string; txHash?: string
  description?: string; isAdminReviewed: boolean; adminNote?: string; createdAt: string; uploadedBy: string
  trade: { tradeRef: string; buyer: { username: string }; seller: { username: string } }
}

export default function AdminCtmProofsPage() {
  const [proofs, setProofs] = useState<CtmProof[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<CtmProof | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchProofs = async () => {
    try {
      const res = await ctmApi.adminGetProofs({ reviewed: 'false', page, limit: 20 })
      const data = res as { proofs: CtmProof[]; total: number }
      setProofs(data.proofs ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchProofs, 60000)

  const handleAction = async (action: 'ok' | 'flag') => {
    if (!selected) return
    setSubmitting(true)
    try {
      await ctmApi.adminReviewProof(selected.id, { action, adminNote: adminNote.trim() || undefined })
      setSelected(null); setAdminNote('')
      await fetchProofs()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Action failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Proof Review Queue ({total})</h1>
          <p className="text-sm text-text-muted mt-0.5">Unreviewed CTM trade proofs from new merchants</p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-48 animate-pulse" />)}
        </div>
      ) : proofs.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <p className="text-4xl mb-3">✓</p>
          <p>All proofs reviewed.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {proofs.map((p) => (
            <button key={p.id} onClick={() => { setSelected(p); setAdminNote('') }} className="bg-surface shadow-card border border-border rounded-xl overflow-hidden hover:border-primary transition-colors text-left">
              {p.fileUrl ? (
                <img src={p.fileUrl} alt="proof" className="w-full h-36 object-cover" />
              ) : (
                <div className="w-full h-36 bg-surface flex items-center justify-center text-text-muted text-sm">
                  {p.txHash ? 'TX Hash' : 'No image'}
                </div>
              )}
              <div className="p-2">
                <p className="text-xs font-medium text-text-primary truncate">#{p.trade.tradeRef.slice(-8)}</p>
                <p className="text-xs text-text-muted">{p.proofType} · {new Date(p.createdAt).toLocaleDateString()}</p>
                <p className="text-xs text-text-muted truncate">{p.trade.buyer.username} / {p.trade.seller.username}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={proofs.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Proof detail modal */}
      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title="Proof Review"
        size="lg"
        footer={
          selected && (
            <div className="flex gap-3">
              <button onClick={() => handleAction('ok')} disabled={submitting} className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {submitting ? '…' : '✓ Mark OK'}
              </button>
              <button onClick={() => handleAction('flag')} disabled={submitting} className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {submitting ? '…' : '⚑ Flag Suspicious'}
              </button>
            </div>
          )
        }
      >
        {selected && (
          <div className="space-y-5">
            {selected.fileUrl && (
              <a href={selected.fileUrl} target="_blank" rel="noopener noreferrer">
                <img src={selected.fileUrl} alt="proof" className="w-full rounded-xl border border-border" />
                <p className="text-xs text-primary mt-1 hover:underline">Open full resolution ↗</p>
              </a>
            )}

            {selected.txHash && (
              <div className="bg-surface rounded-xl p-3 text-sm">
                <p className="text-text-muted text-xs mb-1">Transaction Hash</p>
                <p className="font-mono text-xs text-text-primary break-all">{selected.txHash}</p>
              </div>
            )}

            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-text-muted">Trade</span>
                <span className="font-mono">#{selected.trade.tradeRef.slice(-10)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Type</span>
                <span>{selected.proofType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Uploaded</span>
                <span>{new Date(selected.createdAt).toLocaleString()}</span>
              </div>
              {selected.fileHash && (
                <div className="flex justify-between">
                  <span className="text-text-muted">SHA-256</span>
                  <span className="font-mono text-xs text-text-muted truncate max-w-[180px]">{selected.fileHash}</span>
                </div>
              )}
              {selected.description && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Description</span>
                  <span className="max-w-[200px] text-right">{selected.description}</span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Admin Note (optional)</label>
              <textarea rows={2} value={adminNote} onChange={(e) => setAdminNote(e.target.value)} placeholder="Internal note about this proof…" className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
