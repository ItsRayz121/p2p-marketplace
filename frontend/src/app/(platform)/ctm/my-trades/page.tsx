'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'

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

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'awaiting_payment', label: 'Awaiting Payment' },
  { value: 'payment_uploaded', label: 'Proof Uploaded' },
  { value: 'payment_confirmed', label: 'Confirmed' },
  { value: 'seller_transferring', label: 'Crypto Sent' },
  { value: 'completed', label: 'Completed' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

const ROLE_OPTIONS = ['all', 'buyer', 'seller'] as const

type StatusFilter = typeof STATUS_OPTIONS[number]['value']
type RoleFilter = typeof ROLE_OPTIONS[number]

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
  const { user } = useAuth()
  const [trades, setTrades] = useState<Trade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [role, setRole] = useState<RoleFilter>('all')
  const [page, setPage] = useState(1)

  const fetchTrades = useCallback(async () => {
    try {
      const res = await ctmApi.getMyTrades({
        ...(status !== 'all' ? { status } : {}),
        ...(role !== 'all' ? { role } : {}),
        page,
        limit: 20,
      })
      const data = res as { trades: Trade[]; total: number }
      setTrades(data.trades ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [status, role, page])

  useEffect(() => {
    setLoading(true)
    void fetchTrades()
  }, [fetchTrades])

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary mb-4">My CTM Trades</h1>

      {/* Market segmented control */}
      <div className="flex bg-surface border border-border rounded-lg overflow-hidden mb-4 w-fit">
        <Link
          href="/orders"
          className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-white transition-colors"
        >
          USDT P2P
        </Link>
        <button className="px-4 py-2 text-sm font-medium bg-primary text-white">
          Community Tokens
        </button>
      </div>

      {/* Filters — all chips on a single wrapping row */}
      <div className="flex flex-wrap gap-1 mb-6">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => { setStatus(opt.value); setPage(1) }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              status === opt.value
                ? 'bg-primary text-white'
                : 'bg-white border border-border text-text-secondary hover:bg-surface'
            }`}
          >
            {opt.label}
          </button>
        ))}

        <div className="w-px bg-border self-stretch mx-0.5" />

        {ROLE_OPTIONS.map((r) => (
          <button
            key={r}
            onClick={() => { setRole(r); setPage(1) }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              role === r
                ? 'bg-primary/10 text-primary border border-primary/30'
                : 'bg-white border border-border text-text-secondary hover:bg-surface'
            }`}
          >
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No trades matching the current filters.</div>
      ) : (
        <div className="space-y-3">
          {trades.map((t) => {
            const isBuyer = user?.id === t.buyer.id
            return (
              <Link key={t.id} href={`/ctm/trade/${t.tradeRef}`} className="block bg-white border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <EntityLogo type="token" slug={t.token.symbol} size="xl" logoUrl={t.token.logoUrl} />
                    <div>
                      <p className="font-semibold text-text-primary">{t.tokenAmount} {t.token.symbol}</p>
                      <p className="text-xs text-text-muted">PKR {Number(t.fiatAmount).toLocaleString()} · #{t.tradeRef.slice(-8)}</p>
                      <p className="text-xs text-text-muted">{isBuyer ? 'Buyer' : 'Seller'}</p>
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
            )
          })}
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
