'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { UserAvatar } from '@/components/ui/UserAvatar'

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

function getPkrDisplay(t: Trade): string {
  const direct = parseFloat(t.fiatAmount ?? t.totalPkr ?? '')
  if (Number.isFinite(direct) && direct > 0) {
    return `PKR ${direct.toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
  }
  const calc = parseFloat(t.price) * parseFloat(t.amount)
  if (Number.isFinite(calc) && calc > 0) {
    return `PKR ${calc.toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
  }
  return '—'
}


export default function OrdersPage() {
  const { user } = useAuth()
  const router = useRouter()
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
          className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-alt transition-colors"
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
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
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
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
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
              <thead className="bg-surface border-b-2 border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-secondary uppercase tracking-wide">Counterparty</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-text-secondary uppercase tracking-wide">Crypto</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-text-secondary uppercase tracking-wide">PKR</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-text-secondary uppercase tracking-wide">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trades.map((t) => {
                  const isBuyer = t.buyerId === user?.id
                  const cp = isBuyer ? t.seller : t.buyer
                  const counterparty = cp?.fullName || cp?.username || (isBuyer ? 'Seller' : 'Buyer')
                  return (
                    <tr
                      key={t.id}
                      onClick={() => router.push(`/trade/${t.id}`)}
                      className="hover:bg-primary/5 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        {(() => { const s = getTradeStatus(t.status); return <Badge variant={s.variant} icon={s.icon} size="sm">{s.label}</Badge> })()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isBuyer ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>
                          {isBuyer ? 'Buyer' : 'Seller'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <UserAvatar name={counterparty} avatarUrl={cp?.avatarUrl} size="xs" />
                          <span className="text-sm font-medium text-primary hover:underline">{counterparty}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-text-primary text-right font-mono">
                        {parseFloat(t.amount).toFixed(4)} {t.coin}
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-text-primary text-right">
                        {getPkrDisplay(t)}
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted text-right">
                        {timeAgo(t.createdAt)}
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
              const cp = isBuyer ? t.seller : t.buyer
              const counterparty = cp?.fullName || cp?.username || (isBuyer ? 'Seller' : 'Buyer')
              return (
                <Link key={t.id} href={`/trade/${t.id}`}>
                  <div className="bg-surface rounded-xl border border-border shadow-card p-4 hover:shadow-card-md transition-shadow">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        {(() => { const s = getTradeStatus(t.status); return <Badge variant={s.variant} icon={s.icon} size="sm">{s.label}</Badge> })()}
                        <div className="flex items-center gap-1.5 mt-1">
                          <UserAvatar name={counterparty} avatarUrl={cp?.avatarUrl} size="xs" />
                          <p className="text-sm font-medium text-text-primary">{counterparty}</p>
                        </div>
                        <p className={`text-xs font-medium mt-0.5 ${isBuyer ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'}`}>{isBuyer ? 'You bought' : 'You sold'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-text-primary">
                          {parseFloat(t.amount).toFixed(4)} {t.coin}
                        </p>
                        <p className="text-xs text-text-muted">{getPkrDisplay(t)}</p>
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
