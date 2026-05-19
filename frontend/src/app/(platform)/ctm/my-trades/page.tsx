'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'

const STATUS_COLORS: Record<string, string> = {
  awaiting_payment: 'bg-yellow-100 text-yellow-800',
  payment_uploaded: 'bg-blue-100 text-blue-800',
  payment_confirmed: 'bg-blue-100 text-blue-800',
  seller_transferring: 'bg-indigo-100 text-indigo-800',
  proof_submitted: 'bg-purple-100 text-purple-800',
  buyer_confirming: 'bg-purple-100 text-purple-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
  disputed: 'bg-red-100 text-red-800',
  dispute_resolved: 'bg-orange-100 text-orange-800',
  expired: 'bg-gray-100 text-gray-500',
}

const ACTIVE_STATUSES = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming']

interface Trade {
  id: string
  tradeRef: string
  status: string
  tokenAmount: string
  fiatAmount: string
  expiresAt: string
  createdAt: string
  token: { name: string; symbol: string; logoUrl?: string }
  buyer: { id: string; username: string }
  seller: { id: string; username: string }
}

export default function MyCtmTradesPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'active' | 'completed' | 'disputed'>('active')
  const [page, setPage] = useState(1)

  const statusFilter = tab === 'active' ? undefined : tab === 'completed' ? 'completed' : 'disputed'

  const fetchTrades = async () => {
    try {
      const res = await ctmApi.getMyTrades({ status: statusFilter, page, limit: 20 })
      const data = res as { trades: Trade[]; total: number }
      // Filter active client-side when no status filter
      const all = data.trades ?? []
      const filtered = tab === 'active' ? all.filter((t) => ACTIVE_STATUSES.includes(t.status)) : all
      setTrades(filtered)
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchTrades, 15000)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-6">My CTM Trades</h1>

      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-6 w-fit">
        {(['active', 'completed', 'disputed'] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setPage(1) }}
            className={`px-5 py-2 rounded-lg text-sm font-semibold capitalize transition-colors ${tab === t ? 'bg-white text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}>
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-white border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No {tab} trades yet.</div>
      ) : (
        <div className="space-y-3">
          {trades.map((t) => (
            <Link key={t.id} href={`/ctm/trade/${t.tradeRef}`} className="block bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {t.token.logoUrl ? (
                    <img src={t.token.logoUrl} alt={t.token.name} className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center text-sm">{t.token.symbol.charAt(0)}</div>
                  )}
                  <div>
                    <p className="font-semibold text-text-primary">{t.tokenAmount} {t.token.symbol}</p>
                    <p className="text-xs text-text-muted">PKR {Number(t.fiatAmount).toLocaleString()} · #{t.tradeRef.slice(-8)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {t.status.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-text-muted">{new Date(t.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2 mt-8">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={trades.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  )
}
