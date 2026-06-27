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
  displayRef?: string | null
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

      {/* Market segmented control — equal-width halves on mobile (matches the
          USDT P2P Orders page), compact on desktop. */}
      <div className="flex bg-surface border border-border rounded-lg overflow-hidden mb-4 w-full sm:w-fit">
        <Link
          href="/orders"
          className="flex-1 sm:flex-none px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-alt transition-colors text-center"
        >
          USDT P2P
        </Link>
        <button className="flex-1 sm:flex-none px-4 py-2 text-sm font-medium bg-primary text-white text-center">
          Community Tokens
        </button>
      </div>

      {/* Filters — mobile: chips fill the full width in tidy grids (status in
          2 columns, role in 3), matching the USDT P2P Orders page so there are
          no ragged trailing gaps or sideways scroll; desktop (sm+): inline wrap. */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:flex-wrap sm:items-start">
        {/* Status */}
        <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { setStatus(opt.value); setPage(1) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors text-center ${
                status === opt.value
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="w-px bg-border hidden sm:block" />

        {/* Role */}
        <div className="grid grid-cols-3 gap-1.5 sm:flex sm:gap-1">
          {ROLE_OPTIONS.map((r) => (
            <button
              key={r}
              onClick={() => { setRole(r); setPage(1) }}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors text-center ${
                role === r
                  ? 'bg-primary/10 text-primary border border-primary/30'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
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
        <>
        {/* Desktop table */}
        <div className="hidden sm:block bg-surface shadow-card rounded-xl border border-border overflow-hidden">
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
                        <div className="min-w-0">
                          <span className="block text-sm font-semibold text-text-primary">{t.token.symbol}</span>
                          {t.displayRef && <span className="block text-[11px] text-text-muted">#{t.displayRef}</span>}
                        </div>
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
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-surface-alt text-text-secondary'}`}>
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

        {/* Mobile cards — full detail (token, ref, role, status, PKR, date) with
            nothing clipped, instead of a sideways-scrolling table. */}
        <div className="sm:hidden space-y-3">
          {trades.map((t) => {
            const isBuyer = user?.id === t.buyer.id
            return (
              <Link key={t.id} href={`/ctm/trade/${t.tradeRef}`}>
                <div className="bg-surface rounded-xl border border-border shadow-card p-4 hover:shadow-card-md transition-shadow">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <EntityLogo type="token" slug={t.token.symbol} size="sm" logoUrl={t.token.logoUrl} />
                      <div className="min-w-0">
                        <span className="block text-sm font-bold text-text-primary">{t.token.symbol}</span>
                        {t.displayRef && <span className="block text-[11px] text-text-muted truncate">#{t.displayRef}</span>}
                      </div>
                    </div>
                    <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? 'bg-surface-alt text-text-secondary'}`}>
                      {t.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="flex items-end justify-between gap-2 mt-2">
                    <div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isBuyer ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>
                        {isBuyer ? 'Buyer' : 'Seller'}
                      </span>
                      <p className="text-xs text-text-muted mt-1">{new Date(t.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-text-primary">PKR {Number(t.fiatAmount).toLocaleString()}</p>
                      <p className="text-xs text-text-muted font-mono">{t.tokenAmount} {t.token.symbol}</p>
                    </div>
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
        </>
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
