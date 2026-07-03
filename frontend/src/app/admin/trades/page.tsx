'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ClipboardList, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input } from '@/components/ui/Input'
import { EntityLogo } from '@/components/ui/EntityLogo'

interface AdminTrade {
  id: string
  buyerId: string
  sellerId: string
  coin: string
  amount: string
  totalPkr?: string
  status: string
  paymentMethod?: string
  buyer?: { email: string; username: string }
  seller?: { email: string; username: string }
  createdAt: string
}

interface TradesResponse {
  trades: AdminTrade[]
  total: number
}

const statusVariant = (s: string) => {
  if (s === 'released' || s === 'completed' || s === 'crypto_released') return 'success'
  if (s === 'disputed') return 'danger'
  if (s === 'cancelled' || s === 'expired') return 'warning'
  if (s === 'payment_uploaded' || s === 'paid') return 'gold'
  return 'default'
}

const TRADE_STATUS_LABELS: Record<string, string> = {
  payment_pending:   'Awaiting Payment',
  payment_uploaded:  'Proof Uploaded',
  payment_confirmed: 'Payment Confirmed',
  crypto_sent:       'Crypto Sent',
  crypto_released:   'Completed',
  disputed:          'Disputed',
  cancelled:         'Cancelled',
  expired:           'Expired',
  released:          'Completed',
  completed:         'Completed',
  paid:              'Paid',
  active:            'Active',
  pending:           'Pending',
}
const tradeStatusLabel = (s: string) => TRADE_STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export default function TradesPage() {
  const [trades, setTrades] = useState<AdminTrade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [coinFilter, setCoinFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const [selectedTrade, setSelectedTrade] = useState<AdminTrade | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [confirmConfirm, setConfirmConfirm] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const limit = 20

  const fetchTrades = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      if (coinFilter) params.coin = coinFilter
      if (dateFrom) params.dateFrom = dateFrom
      if (dateTo) params.dateTo = dateTo
      if (search.trim()) params.search = search.trim()
      const data = await adminApi.getTrades(params) as TradesResponse
      setTrades(data.trades ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trades')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, coinFilter, dateFrom, dateTo, search])

  usePolling(fetchTrades, 30_000)

  async function handleConfirmPayment() {
    if (!selectedTrade) return
    setActionError(null)
    try {
      await adminApi.adminConfirmPayment(selectedTrade.id)
      setConfirmConfirm(false)
      setSelectedTrade(null)
      setActionSuccess('Payment confirmed successfully.')
      fetchTrades()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to confirm payment')
    }
  }

  async function handleCancelTrade() {
    if (!selectedTrade) return
    setActionError(null)
    try {
      await adminApi.adminCancelTrade(selectedTrade.id)
      setConfirmCancel(false)
      setSelectedTrade(null)
      setActionSuccess('Trade cancelled successfully.')
      fetchTrades()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel trade')
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading trades..." />
  if (error && trades.length === 0) return <ErrorState title={error} onRetry={fetchTrades} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">USDT Trades</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} trades</p>
      </div>

      {actionSuccess && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">
          {actionSuccess}
        </div>
      )}
      {actionError && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">
          {actionError}
        </div>
      )}

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-3">
        <div className="w-56">
          <Input
            placeholder="Search trade ID, buyer, seller…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="all">All Statuses</option>
          <option value="payment_pending">Awaiting Payment</option>
          <option value="payment_uploaded">Proof Uploaded</option>
          <option value="payment_confirmed">Payment Confirmed</option>
          <option value="crypto_sent">Crypto Sent</option>
          <option value="crypto_released">Completed</option>
          <option value="disputed">Disputed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <div className="w-36">
          <Input
            placeholder="Coin (e.g. USDT)"
            value={coinFilter}
            onChange={(e) => { setCoinFilter(e.target.value.toUpperCase()); setPage(1) }}
          />
        </div>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {(statusFilter !== 'all' || coinFilter || dateFrom || dateTo || search) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setStatusFilter('all'); setCoinFilter(''); setDateFrom(''); setDateTo(''); setSearch(''); setPage(1) }}
          >
            Clear
          </Button>
        )}
      </div>

      {trades.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No trades found" description="No trades match the current filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Trade ID</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Buyer</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Seller</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Coin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trades.map((t) => (
                  <tr key={t.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs" data-label="Trade ID">
                      <Link
                        href={`/admin/trades/${t.id}`}
                        className="text-primary hover:underline inline-flex items-center gap-1"
                        title={t.id}
                      >
                        {t.id.slice(0, 10)}…
                        <ExternalLink size={11} className="opacity-60" />
                      </Link>
                    </td>
                    <td className="px-4 py-3" data-label="Buyer">
                      <p className="text-text-primary">{t.buyer?.username || t.buyerId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3" data-label="Seller">
                      <p className="text-text-primary">{t.seller?.username || t.sellerId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3" data-label="Coin">
                      <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
                        <EntityLogo type="token" slug={t.coin} size="sm" />
                        {t.coin}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary" data-label="Amount">{t.amount}</td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={statusVariant(t.status)} size="sm">{tradeStatusLabel(t.status)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Date">{fmtDate(t.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {(t.status === 'payment_uploaded' || t.status === 'paid') && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setSelectedTrade(t)
                              setActionError(null)
                              setConfirmConfirm(true)
                            }}
                          >
                            Confirm Payment
                          </Button>
                        )}
                        {(t.status === 'active' || t.status === 'pending') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSelectedTrade(t)
                              setCancelReason('')
                              setActionError(null)
                              setConfirmCancel(true)
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmConfirm}
        onClose={() => setConfirmConfirm(false)}
        onConfirm={handleConfirmPayment}
        title="Confirm Payment"
        description={`Manually confirm payment for trade ${selectedTrade?.id.slice(0, 8)}...? This will advance the trade to the release stage.`}
        confirmLabel="Confirm Payment"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={handleCancelTrade}
        title="Cancel Trade"
        description={`Cancel trade ${selectedTrade?.id.slice(0, 8)}...? The locked crypto will be returned to the seller.`}
        confirmLabel="Cancel Trade"
        confirmVariant="danger"
      />
    </div>
  )
}

