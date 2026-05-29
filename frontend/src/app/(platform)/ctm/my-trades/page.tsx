'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { EntityLogo } from '@/components/ui/EntityLogo'

const STATUS_COLORS: Record<string, string> = {
  awaiting_payment:   'bg-warning/10 text-warning',
  payment_uploaded:   'bg-primary/10 text-primary',
  payment_confirmed:  'bg-primary/10 text-primary',
  seller_transferring:'bg-info/10 text-info',
  proof_submitted:    'bg-info/10 text-info',
  buyer_confirming:   'bg-info/10 text-info',
  completed:          'bg-success/10 text-success',
  cancelled:          'bg-surface-alt text-text-secondary',
  disputed:           'bg-danger/10 text-danger',
  dispute_resolved:   'bg-warning/10 text-warning',
  expired:            'bg-surface-alt text-text-muted',
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

      {/* Filters – single scrollable row */}
      <div className="overflow-x-auto mb-6 -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="flex items-center gap-1 min-w-max">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setStatus(opt.value); setPage(1) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                status === opt.value
                  ? 'bg-primary text-white'
                  : 'bg-white border border-border text-text-secondary hover:bg-surface'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <div className="w-px h-5 bg-border mx-2 shrink-0" />
          {ROLE_OPTIONS.map((r) => (
            <button
              key={r}
              onClick={() => { setRole(r); setPage(1) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                role === r
                  ? 'bg-primary/10 text-primary border border-primary/30'
                  : 'bg-white border border-border text-text-secondary hover:bg-surface'
              }`}
            >
              {r === 'all' ? 'All Roles' : r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : trades.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No trades matching the current filters.</div>
      ) : (
        <div className="bg-white shadow-card rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-surface border-b-2 border-border">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Token</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide hidden sm:table-cell">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide hidden sm:table-cell">PKR</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Role</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-text-secondary uppercase tracking-wide">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {trades.map((t) => {
                const isBuyer = user?.id === t.buyer.id
                return (
                  <tr
                    key={t.id}
                    onClick={() => { window.location.href = `/ctm/trade/${t.tradeRef}` }}
                    className="hover:bg-primary/5 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <EntityLogo type="token" slug={t.token.symbol} size="sm" logoUrl={t.token.logoUrl} />
                        <span className="text-sm font-semibold text-text-primary">{t.token.symbol}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary font-mono hidden sm:table-cell">
                      {t.tokenAmount}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-text-primary hidden sm:table-cell">
                      PKR {Number(t.fiatAmount).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {isBuyer ? 'Buyer' : 'Seller'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {t.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted text-right">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
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
