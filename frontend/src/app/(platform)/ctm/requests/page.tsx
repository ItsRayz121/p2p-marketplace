'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/store/auth.store'

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

interface Bid { id: string; bidderId: string; pricePerUnit: string; totalPkr: string; message?: string; status: string }
interface Request {
  id: string
  side: string
  amount: string
  targetPricePkr?: string
  paymentMethods: string[]
  note?: string
  status: string
  expiresAt: string
  token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string }
  user: { id: string; username: string }
  bids: Bid[]
  _count?: { bids: number }
}

export default function RequestBoardPage() {
  const { user } = useAuthStore()
  const [requests, setRequests] = useState<Request[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [page, setPage] = useState(1)
  const [bidModal, setBidModal] = useState<Request | null>(null)
  const [bidPrice, setBidPrice] = useState('')
  const [bidMsg, setBidMsg] = useState('')
  const [bidSubmitting, setBidSubmitting] = useState(false)
  const [bidError, setBidError] = useState('')

  const fetchRequests = async () => {
    try {
      const res = await ctmApi.getRequests({ side, page, limit: 20 })
      const data = res as { requests: Request[]; total: number }
      setRequests(data.requests ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchRequests, 15000)

  const handleAcceptBid = async (requestId: string, bidId: string) => {
    try {
      const res = await ctmApi.acceptBid(requestId, bidId)
      const trade = res as { tradeRef: string }
      window.location.href = `/ctm/trade/${trade.tradeRef}`
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to accept bid')
    }
  }

  const handleSubmitBid = async () => {
    if (!bidModal || !bidPrice) return
    setBidError('')
    setBidSubmitting(true)
    try {
      await ctmApi.submitBid(bidModal.id, { pricePerUnit: parseFloat(bidPrice), message: bidMsg || undefined })
      setBidModal(null)
      setBidPrice('')
      setBidMsg('')
    } catch (err: unknown) {
      setBidError((err as Error).message ?? 'Failed to submit bid')
    } finally {
      setBidSubmitting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Request Board</h1>
          <p className="text-text-muted text-sm">Post your need, let merchants compete</p>
        </div>
        <div className="flex gap-2">
          <Link href="/ctm/my-requests" className="border border-border px-4 py-2 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">My Requests</Link>
          <Link href="/ctm/requests/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">+ Post Request</Link>
        </div>
      </div>

      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-6 w-fit">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setPage(1) }}
            className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors ${side === s ? 'bg-white text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}>
            {s === 'buy' ? 'Buy Requests' : 'Sell Requests'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-28 animate-pulse" />)}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No open {side} requests. <Link href="/ctm/requests/create" className="text-primary hover:underline">Post the first one →</Link></div>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => {
            const isOwner = user?.id === r.user.id
            return (
              <div key={r.id} className="bg-white border border-border rounded-xl p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    {r.token.logoUrl ? (
                      <img src={r.token.logoUrl} alt={r.token.name} className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center text-sm">{r.token.symbol.charAt(0)}</div>
                    )}
                    <div>
                      <p className="font-semibold text-text-primary">{r.amount} {r.token.symbol}</p>
                      <p className="text-xs text-text-muted">by {r.user.username} · {timeLeft(r.expiresAt)} left</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm text-text-muted">{r._count?.bids ?? r.bids?.length ?? 0} bids</span>
                    {r.targetPricePkr && <span className="text-sm font-medium text-text-primary">~PKR {Number(r.targetPricePkr).toLocaleString()}</span>}
                    {isOwner ? (
                      <Link href="/ctm/my-requests" className="bg-surface border border-border px-3 py-1.5 rounded-lg text-sm font-medium">View Bids</Link>
                    ) : (
                      <button onClick={() => { setBidModal(r); setBidError(''); setBidPrice(''); setBidMsg('') }}
                        className="bg-primary text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors">
                        Bid
                      </button>
                    )}
                  </div>
                </div>
                {r.note && <p className="text-sm text-text-muted mt-3 border-t border-border pt-3">{r.note}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {r.paymentMethods.map((m) => <span key={m} className="text-xs bg-surface px-2 py-0.5 rounded-full border border-border">{m}</span>)}
                </div>

                {/* Owner sees bids inline */}
                {isOwner && r.bids && r.bids.length > 0 && (
                  <div className="mt-4 border-t border-border pt-4 space-y-2">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">Bids received</p>
                    {r.bids.filter((b) => b.status === 'pending').map((b) => (
                      <div key={b.id} className="flex items-center justify-between bg-surface rounded-xl px-3 py-2.5">
                        <div>
                          <p className="font-semibold text-text-primary text-sm">PKR {Number(b.totalPkr).toLocaleString()}</p>
                          <p className="text-xs text-text-muted">PKR {Number(b.pricePerUnit).toLocaleString()} per token{b.message ? ` · ${b.message}` : ''}</p>
                        </div>
                        <button onClick={() => handleAcceptBid(r.id, b.id)} className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-green-700 transition-colors">Accept</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2 mt-8">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={requests.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Bid modal */}
      {bidModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Submit Bid</h3>
            <p className="text-sm text-text-muted">For: {bidModal.amount} {bidModal.token.symbol}</p>
            {bidError && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{bidError}</div>}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Your price per token (PKR) *</label>
              <input type="number" min="0" step="0.01" value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              {bidPrice && <p className="text-xs text-text-muted mt-1">Total: PKR {(parseFloat(bidPrice) * parseFloat(bidModal.amount)).toLocaleString()}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Message (optional)</label>
              <textarea rows={2} value={bidMsg} onChange={(e) => setBidMsg(e.target.value)} placeholder="e.g. I can complete in 30 minutes" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setBidModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary">Cancel</button>
              <button onClick={handleSubmitBid} disabled={bidSubmitting || !bidPrice} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-60">
                {bidSubmitting ? 'Submitting…' : 'Submit Bid'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
