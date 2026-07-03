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
import { Flame, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EntityLogo } from '@/components/ui/EntityLogo'

// The admin gas-orders endpoint returns raw GasFeeOrder rows; we only type the
// fields this table renders.
interface AdminGasOrder {
  id: string
  orderRef: string
  userId?: string | null
  merchantApiKeyId?: string | null
  isFreeGrant?: boolean
  chain: string
  gasTokenConfig?: { symbol: string; logoUrl?: string | null } | null
  gasAmountUSD: string
  paymentAmount: string
  paymentCoin?: string
  paymentNetwork?: string
  status: string
  createdAt: string
  user?: { username?: string | null; email?: string | null } | null
}

interface GasOrdersResponse {
  orders: AdminGasOrder[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'danger' | 'gold' => {
  if (s === 'delivered') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'refunded' || s === 'cancelled' || s === 'awaiting_refund' || s === 'refund_pending') return 'warning'
  if (s === 'payment_uploaded' || s === 'payment_detected' || s === 'payment_verified' || s === 'sending') return 'gold'
  return 'default'
}

const GAS_STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Uploaded',
  payment_verified: 'Payment Verified',
  payment_detected: 'Payment Detected',
  sending:          'Sending',
  delivered:        'Delivered',
  expired:          'Expired',
  failed:           'Failed',
  awaiting_refund:  'Awaiting Refund',
  refund_pending:   'Refund Pending',
  refunded:         'Refunded',
  cancelled:        'Cancelled',
}
const gasStatusLabel = (s: string) => GAS_STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Client-side "source" classification for each order.
function orderSource(o: AdminGasOrder): 'merchant' | 'free' | 'direct' {
  if (o.merchantApiKeyId) return 'merchant'
  if (o.isFreeGrant) return 'free'
  return 'direct'
}

// Filter tabs → query params for GET /admin/gas/orders.
const SOURCE_TABS: { value: string; label: string; params: Record<string, string> }[] = [
  { value: 'all',    label: 'All',      params: {} },
  { value: 'crypto', label: 'Crypto',   params: { paymentType: 'CRYPTO' } },
  { value: 'pkr',    label: 'PKR',      params: { paymentCoin: 'PKR' } },
  { value: 'free',   label: 'Free Gas', params: { freeGrant: 'true' } },
]

export default function GasTradesPage() {
  const [orders, setOrders] = useState<AdminGasOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [sourceTab, setSourceTab] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [merchantOnly, setMerchantOnly] = useState(false)

  const limit = 20

  const fetchOrders = useCallback(async () => {
    try {
      const tab = SOURCE_TABS.find((t) => t.value === sourceTab) ?? SOURCE_TABS[0]!
      const params: Record<string, string | number> = { page, limit, ...tab.params }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getGasOrders(params) as unknown as GasOrdersResponse
      let rows = data.orders ?? []
      // The backend has no merchant filter, so refine "merchant only" client-side.
      if (merchantOnly) rows = rows.filter((o) => !!o.merchantApiKeyId)
      setOrders(rows)
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gas trades')
    } finally {
      setLoading(false)
    }
  }, [page, sourceTab, statusFilter, merchantOnly])

  usePolling(fetchOrders, 30_000)

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading gas trades..." />
  if (error && orders.length === 0) return <ErrorState title={error} onRetry={fetchOrders} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Gas Trades</h1>
        <p className="text-text-muted text-sm mt-0.5">
          Every crypto-gas order — direct user buys, merchant API orders, and free-gas grants. {total.toLocaleString()} orders
        </p>
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap items-center gap-3">
        <div className="admin-toolbar gap-2">
          {SOURCE_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => { setSourceTab(t.value); setPage(1) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                sourceTab === t.value
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface text-text-secondary border-border hover:bg-surface'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="all">All Statuses</option>
          {Object.entries(GAS_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-text-secondary select-none">
          <input
            type="checkbox"
            checked={merchantOnly}
            onChange={(e) => { setMerchantOnly(e.target.checked); setPage(1) }}
            className="w-4 h-4 accent-primary"
          />
          Merchant orders only
        </label>
      </div>

      {orders.length === 0 ? (
        <EmptyState icon={Flame} title="No gas trades found" description="No gas orders match the current filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Order Ref</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">User</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Source</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Gas (USD)</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Paid</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Status</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((o) => {
                  const src = orderSource(o)
                  return (
                    <tr key={o.id} className="align-middle hover:bg-surface/50 transition-colors">
                      <td className="px-3 py-2 font-mono text-xs" data-label="Order Ref">
                        <Link
                          href={`/admin/gas/orders/${o.orderRef}`}
                          className="text-primary hover:underline inline-flex items-center gap-1"
                          title={o.orderRef}
                        >
                          {o.orderRef}
                          <ExternalLink size={11} className="opacity-60" />
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-text-primary" data-label="User">
                        {o.user?.username || o.user?.email || (o.merchantApiKeyId ? 'Merchant API' : 'Guest')}
                      </td>
                      <td className="px-3 py-2" data-label="Source">
                        {src === 'merchant'
                          ? <Badge variant="default" size="sm">Merchant</Badge>
                          : src === 'free'
                          ? <Badge variant="gold" size="sm">Free Gas</Badge>
                          : <Badge variant="outline" size="sm">Direct</Badge>}
                      </td>
                      <td className="px-3 py-2" data-label="Chain">
                        <span className="inline-flex items-center gap-1.5 text-text-primary">
                          <EntityLogo type="token" slug={o.gasTokenConfig?.symbol || o.chain} logoUrl={o.gasTokenConfig?.logoUrl ?? null} size="sm" />
                          {o.gasTokenConfig?.symbol || o.chain}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text-primary" data-label="Gas (USD)">${Number(o.gasAmountUSD).toFixed(2)}</td>
                      <td className="px-3 py-2 text-text-primary" data-label="Paid">
                        {o.paymentCoin === 'PKR'
                          ? `PKR ${Number(o.paymentAmount).toLocaleString()}`
                          : `${Number(o.paymentAmount).toFixed(2)} ${o.paymentCoin || 'USDT'}`}
                      </td>
                      <td className="px-3 py-2" data-label="Status">
                        <Badge variant={statusVariant(o.status)} size="sm">{gasStatusLabel(o.status)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-text-secondary" data-label="Date">{fmtDate(o.createdAt)}</td>
                    </tr>
                  )
                })}
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
    </div>
  )
}
