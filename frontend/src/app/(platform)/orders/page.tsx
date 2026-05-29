'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { tradesApi } from '@/lib/api'
import type { Trade } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { getTradeStatus } from '@/lib/tradeStatus'
import { ClipboardList } from 'lucide-react'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'payment_pending', label: 'Awaiting Payment' },
  { value: 'payment_uploaded', label: 'Proof Uploaded' },
  { value: 'payment_confirmed', label: 'Confirmed' },
  { value: 'crypto_sent', label: 'Crypto Sent' },
  { value: 'crypto_released', label: 'Completed' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

const ROLE_OPTIONS = ['all', 'buyer', 'seller'] as const

type StatusFilter = typeof STATUS_OPTIONS[number]['value']
type RoleFilter = typeof ROLE_OPTIONS[number]

const PAGE_SIZE = 20

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}


export default function OrdersPage() {
  const { user } = useAuth()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [role, setRole] = useState<RoleFilter>('all')
  const [trades, setTrades] = useState<Trade[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchTrades = useCallback(async (p = 1, append = false) => {
    try {
      const res = await tradesApi.getMyTrades({
        page: p,
        limit: PAGE_SIZE,
        status: status !== 'all' ? status : undefined,
        role: role !== 'all' ? (role as 'buyer' | 'seller') : undefined,
      })
      setTrades((prev) => (append ? [...prev, ...res.trades] : res.trades))
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [status, role])

  useEffect(() => {
    setLoading(true)
    setPage(1)
    fetchTrades(1, false)
  }, [fetchTrades])

  const handleLoadMore = async () => {
    const next = page + 1
    setPage(next)
    setLoadingMore(true)
    await fetchTrades(next, true)
  }

  const hasMore = trades.length < total

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <h1 className="text-2xl font-bold text-text-primary mb-4">My Orders</h1>

      {/* Market segmented control — switch between USDT P2P trades and CTM trades */}
      <div className="flex bg-surface border border-border rounded-lg overflow-hidden mb-4 w-fit">
        <button className="px-4 py-2 text-sm font-medium bg-primary text-white">
          USDT P2P
        </button>
        <Link
          href="/ctm/my-trades"
          className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-white transition-colors"
        >
          Community Tokens
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        {/* Status */}
        <div className="flex flex-wrap gap-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatus(opt.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                status === opt.value
                  ? 'bg-primary text-white'
                  : 'bg-white border border-border text-text-secondary hover:bg-surface'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="w-px bg-border hidden sm:block" />

        {/* Role */}
        <div className="flex gap-1">
          {ROLE_OPTIONS.map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
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
      </div>

      {loading ? (
        <LoadingState message="Loading orders..." />
      ) : error ? (
        <ErrorState title={error} onRetry={() => fetchTrades(1, false)} />
      ) : trades.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No orders found"
          description="You have no trades matching the current filters."
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-muted">Counterparty</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-text-muted">Crypto</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-text-muted">PKR</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-text-muted">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trades.map((t) => {
                  const isBuyer = t.buyerId === user?.id
                  const counterparty = isBuyer
                    ? (t.seller?.username || 'Seller')
                    : (t.buyer?.username || 'Buyer')
                  return (
                    <tr key={t.id} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        {(() => { const s = getTradeStatus(t.status); return <Badge variant={s.variant} icon={s.icon} size="sm">{s.label}</Badge> })()}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{isBuyer ? 'Buyer' : 'Seller'}</td>
                      <td className="px-4 py-3 text-sm font-medium text-text-primary">{counterparty}</td>
                      <td className="px-4 py-3 text-sm text-text-primary text-right">
                        {parseFloat(t.amount).toFixed(4)} {t.coin}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-primary text-right">
                        PKR {Number(t.totalPkr).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted text-right">
                        <Link href={`/trade/${t.id}`} className="hover:text-primary transition-colors">
                          {timeAgo(t.createdAt)}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {trades.map((t) => {
              const isBuyer = t.buyerId === user?.id
              const counterparty = isBuyer
                ? (t.seller?.username || 'Seller')
                : (t.buyer?.username || 'Buyer')
              return (
                <Link key={t.id} href={`/trade/${t.id}`}>
                  <div className="bg-surface rounded-xl border border-border shadow-card p-4 hover:shadow-card-md transition-shadow">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        {(() => { const s = getTradeStatus(t.status); return <Badge variant={s.variant} icon={s.icon} size="sm">{s.label}</Badge> })()}
                        <p className="text-sm font-medium text-text-primary mt-1">{counterparty}</p>
                        <p className="text-xs text-text-muted">{isBuyer ? 'You bought' : 'You sold'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-text-primary">
                          {parseFloat(t.amount).toFixed(4)} {t.coin}
                        </p>
                        <p className="text-xs text-text-muted">PKR {Number(t.totalPkr).toLocaleString()}</p>
                        <p className="text-xs text-text-muted mt-1">{timeAgo(t.createdAt)}</p>
                      </div>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>

          {hasMore && (
            <div className="mt-6 text-center">
              <Button variant="secondary" loading={loadingMore} onClick={handleLoadMore}>
                Load more
              </Button>
            </div>
          )}

          <p className="text-xs text-text-muted text-center mt-4">{total} total orders</p>
        </>
      )}
    </div>
  )
}
