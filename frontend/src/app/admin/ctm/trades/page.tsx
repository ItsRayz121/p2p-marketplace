'use client'
import { useState } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Modal } from '@/components/ui/Modal'

const STATUS_COLORS: Record<string, string> = {
  awaiting_payment: 'bg-yellow-100 text-yellow-700',
  payment_uploaded: 'bg-blue-100 text-blue-700',
  payment_confirmed: 'bg-blue-100 text-blue-700',
  seller_transferring: 'bg-indigo-100 text-indigo-700',
  proof_submitted: 'bg-purple-100 text-purple-700',
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-600',
  disputed: 'bg-red-100 text-red-700',
  dispute_resolved: 'bg-green-100 text-green-700',
  expired: 'bg-gray-100 text-gray-600',
}

interface CtmAdminTrade {
  id: string; tradeRef: string; tokenId: string; status: string
  fiatAmount: string; tokenAmount: string; pricePerUnit: string
  createdAt: string; expiresAt: string; completedAt?: string
  buyer: { id: string; username: string }; seller: { id: string; username: string }
  token: { id: string; name: string; symbol: string }
  proofs: Array<{ fileUrl?: string; proofType: string; uploadedBy: string; createdAt: string }>
  messages: Array<{ senderId: string; message: string; createdAt: string }>
  dispute?: { id: string; reason: string; status: string }
}

export default function AdminCtmTradesPage() {
  const [trades, setTrades] = useState<CtmAdminTrade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<CtmAdminTrade | null>(null)
  const [actionSubmitting, setActionSubmitting] = useState(false)

  const fetchTrades = async () => {
    try {
      const params: Record<string, string | number> = { page, limit: 20 }
      if (statusFilter) params.status = statusFilter
      if (search) params.ref = search
      const res = await ctmApi.adminGetTrades(params)
      const data = res as { trades: CtmAdminTrade[]; total: number }
      setTrades(data.trades ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchTrades, 30000)

  const timeLeft = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'Expired'
    const m = Math.floor(ms / 60000)
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
  }

  const adminAction = async (action: string, ref: string) => {
    setActionSubmitting(true)
    try {
      if (action === 'confirm-payment') await ctmApi.adminConfirmPayment(ref)
      else if (action === 'release') await ctmApi.adminForceRelease(ref)
      setSelected(null)
      await fetchTrades()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Action failed')
    } finally {
      setActionSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-text-primary">CTM Trades ({total})</h1>
        <div className="flex gap-2">
          <input type="text" placeholder="Search ref…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white w-36 focus:outline-none" />
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }} className="border border-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
            <option value="">All statuses</option>
            <option value="awaiting_payment">Awaiting Payment</option>
            <option value="payment_uploaded">Payment Uploaded</option>
            <option value="payment_confirmed">Payment Confirmed</option>
            <option value="seller_transferring">Seller Transferring</option>
            <option value="proof_submitted">Proof Submitted</option>
            <option value="disputed">Disputed</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-14 animate-pulse" />)}</div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Ref</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Parties</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Amount</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Timer</th>
                <th className="text-right px-4 py-3 text-text-muted font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {trades.map((t) => (
                <tr key={t.id} className="hover:bg-surface/50">
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">#{t.tradeRef.slice(-10)}</td>
                  <td className="px-4 py-3">
                    <p className="text-text-primary text-xs">{t.buyer.username} → {t.seller.username}</p>
                    {t.token && <p className="text-text-muted text-xs">{t.token.symbol}</p>}
                  </td>
                  <td className="px-4 py-3 text-text-primary font-medium">PKR {Number(t.fiatAmount).toLocaleString()}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-gray-100 text-gray-600'}`}>{t.status.replace(/_/g, ' ')}</span></td>
                  <td className="px-4 py-3 text-xs text-text-muted">{['completed','cancelled','expired','dispute_resolved'].includes(t.status) ? '—' : timeLeft(t.expiresAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button onClick={() => setSelected(t)} className="text-xs border border-border px-2 py-1 rounded-lg hover:bg-surface">View</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length === 0 && <p className="text-center py-12 text-text-muted">No trades found.</p>}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={trades.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Trade detail modal */}
      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `Trade #${selected.tradeRef.slice(-10)}` : 'Trade Detail'}
        size="lg"
        footer={
          selected && (
            <div className="flex flex-wrap gap-2">
              {selected.status === 'payment_uploaded' && (
                <button onClick={() => adminAction('confirm-payment', selected.tradeRef)} disabled={actionSubmitting} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-60">
                  {actionSubmitting ? '…' : 'Confirm Payment'}
                </button>
              )}
              {['payment_confirmed','seller_transferring','proof_submitted'].includes(selected.status) && (
                <button onClick={() => adminAction('release', selected.tradeRef)} disabled={actionSubmitting} className="bg-green-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-60">
                  {actionSubmitting ? '…' : 'Force Complete'}
                </button>
              )}
              <button onClick={() => setSelected(null)} className="border border-border text-sm px-4 py-2 rounded-lg">Close</button>
            </div>
          )
        }
      >
        {selected && (
          <div className="space-y-5">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selected.status] ?? 'bg-gray-100 text-gray-600'}`}>{selected.status.replace(/_/g, ' ')}</span>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-surface rounded-xl p-3 space-y-1">
                <p className="text-text-muted text-xs">Buyer</p>
                <p className="font-medium text-text-primary">{selected.buyer.username}</p>
              </div>
              <div className="bg-surface rounded-xl p-3 space-y-1">
                <p className="text-text-muted text-xs">Seller</p>
                <p className="font-medium text-text-primary">{selected.seller.username}</p>
              </div>
              <div className="bg-surface rounded-xl p-3 space-y-1">
                <p className="text-text-muted text-xs">PKR Amount</p>
                <p className="font-bold text-text-primary">PKR {Number(selected.fiatAmount).toLocaleString()}</p>
              </div>
              <div className="bg-surface rounded-xl p-3 space-y-1">
                <p className="text-text-muted text-xs">Token Amount</p>
                <p className="font-medium text-text-primary">{selected.tokenAmount}</p>
              </div>
            </div>

            {selected.proofs?.length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Proofs ({selected.proofs.length})</p>
                <div className="grid grid-cols-3 gap-2">
                  {selected.proofs.map((p, i) => (
                    p.fileUrl ? (
                      <a key={i} href={p.fileUrl} target="_blank" rel="noopener noreferrer">
                        <img src={p.fileUrl} alt="proof" className="w-full h-24 object-cover rounded-xl border border-border" />
                        <p className="text-xs text-text-muted mt-1">{p.proofType}</p>
                      </a>
                    ) : null
                  ))}
                </div>
              </div>
            )}

            {selected.messages?.length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Chat Log ({selected.messages.length} messages)</p>
                <div className="bg-surface rounded-xl p-3 max-h-40 overflow-y-auto space-y-2">
                  {selected.messages.map((m, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-text-muted">{new Date(m.createdAt).toLocaleTimeString()} · </span>
                      <span className="text-text-primary">{m.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selected.dispute && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm">
                <p className="font-medium text-red-700">Dispute: {selected.dispute.reason.replace(/_/g, ' ')}</p>
                <p className="text-red-600 text-xs">Status: {selected.dispute.status}</p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
