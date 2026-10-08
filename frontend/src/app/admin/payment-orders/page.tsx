'use client'
import { useState, useCallback, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Fuel, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { RejectProofModal } from '@/components/admin/GasOrderActionModals'
import { GAS_STATUS_LABELS, gasStatusVariant, isPaidFailed } from '@/lib/gasOrderStatus'
import { PAYMENT_ORDERS_ROUTE, gasOrderHref, paymentOrdersHref, parseGasOrderFilters, type GasPaymentType } from '@/lib/adminRoutes'

interface GasOrder {
  id: string
  orderRef: string
  tier: string | null
  chain: string
  gasAmountNative: string
  paymentAmount: string
  paymentCoin?: string | null
  paymentNetwork?: string | null
  pkrAmount?: string | null
  toAddress: string
  status: 'payment_pending' | 'payment_uploaded' | 'payment_verified' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'awaiting_refund' | 'refund_pending' | 'refunded' | 'cancelled'
  deliveryTxHash?: string
  failureReason?: string
  paymentTxHash?: string | null
  retryCount?: number
  createdAt: string
}

interface GasOrdersResponse {
  orders: GasOrder[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

const CHAIN_SYMBOL: Record<string, string> = { TRON: 'TRX', BSC: 'BNB', ETHEREUM: 'ETH', ETH: 'ETH' }

function fmtNative(amount: string | number): string {
  const n = parseFloat(String(amount))
  return n >= 1 ? String(Math.round(n)) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

// ─── Gas Payment Confirm Modal ────────────────────────────────────────────────

function GasPaymentConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  order,
  type,
}: {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
  order: GasOrder | null
  type: 'usdt' | 'pkr'
}) {
  const [loading, setLoading] = useState(false)

  async function handleConfirm() {
    setLoading(true)
    try { await onConfirm() } finally { setLoading(false) }
  }

  const title = type === 'pkr' ? (order?.paymentNetwork === 'EXCHANGE' ? 'Approve Exchange Transfer' : 'Approve PKR Payment') : 'Confirm Payment & Release Gas'

  const CHAIN_EXPLORER: Record<string, string> = {
    BSC: 'https://bscscan.com/tx/',
    TRON: 'https://tronscan.org/#/transaction/',
    ETHEREUM: 'https://etherscan.io/tx/',
    ETH: 'https://etherscan.io/tx/',
  }

  const explorerBase = order ? (CHAIN_EXPLORER[order.chain] ?? null) : null

  function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
      <div className="flex items-start justify-between gap-3 py-2.5 border-b border-border last:border-0">
        <span className="text-xs font-medium text-text-muted flex-shrink-0 mt-0.5">{label}</span>
        <span className="text-sm text-text-primary text-right">{children}</span>
      </div>
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="flex gap-3">
          <Button variant="secondary" size="md" onClick={onClose} disabled={loading} className="flex-1">Cancel</Button>
          <Button variant="primary" size="md" loading={loading} onClick={handleConfirm} className="flex-1">
            {type === 'pkr' ? 'Approve & Release Gas' : 'Confirm & Release Gas'}
          </Button>
        </div>
      }
    >
      {!order ? (
        <p className="text-sm text-text-muted">Loading order details…</p>
      ) : (
        <div className="space-y-1">
          <InfoRow label="Order">
            <span className="font-mono text-xs bg-surface px-1.5 py-0.5 rounded">{order.orderRef}</span>
          </InfoRow>
          <InfoRow label="Chain">
            <span className="font-medium">{order.chain}</span>
            {order.tier && <span className="ml-1 text-xs text-text-muted">· {order.tier}</span>}
          </InfoRow>
          <InfoRow label="Gas Amount">
            {order.gasAmountNative} {CHAIN_SYMBOL[order.chain] ?? order.chain}
          </InfoRow>
          {type === 'pkr' && order.paymentNetwork !== 'EXCHANGE' ? (
            <InfoRow label="PKR Amount">
              <span className="font-semibold text-primary">PKR {Number(order.pkrAmount ?? 0).toLocaleString()}</span>
            </InfoRow>
          ) : (
            <InfoRow label="Payment">
              <span className="font-semibold text-primary">
                {order.paymentAmount} {order.paymentCoin ?? 'USDT'}
              </span>
            </InfoRow>
          )}
          <InfoRow label="Deliver To">
            <span className="font-mono text-xs break-all">{order.toAddress}</span>
          </InfoRow>
          {order.deliveryTxHash && (
            <InfoRow label="Tx Hash">
              <span className="flex items-center gap-1">
                <span className="font-mono text-xs">{order.deliveryTxHash.slice(0, 12)}…</span>
                {explorerBase && (
                  <a
                    href={`${explorerBase}${order.deliveryTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline text-xs ml-1"
                  >
                    View ↗
                  </a>
                )}
              </span>
            </InfoRow>
          )}
          <p className="pt-3 text-xs text-text-muted">Gas delivery will be queued immediately after confirmation.</p>
        </div>
      )}
    </Modal>
  )
}


// ─── Page ─────────────────────────────────────────────────────────────────────

const PAYMENT_TYPES: { v: GasPaymentType; label: string }[] = [
  { v: 'all', label: 'All' },
  { v: 'MANUAL', label: 'All manual review' },
  { v: 'PKR', label: 'PKR (manual review)' },
  { v: 'EXCHANGE', label: 'Exchange transfer (manual review)' },
  { v: 'CRYPTO', label: 'Crypto (auto-verify)' },
]

// Existing state machine, grouped for scanning only — no states added or renamed.
const STATUS_GROUPS: { label: string; statuses: string[] }[] = [
  { label: 'Queue', statuses: ['all', 'active'] },
  { label: 'Awaiting payment', statuses: ['payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected'] },
  { label: 'Delivery', statuses: ['sending', 'delivered'] },
  { label: 'Problems', statuses: ['expired', 'failed'] },
  { label: 'Refunds & closed', statuses: ['awaiting_refund', 'refund_pending', 'refunded', 'cancelled'] },
]

const LIMIT = 20

export default function PaymentOrdersPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading payment orders..." />}>
      <PaymentOrdersInner />
    </Suspense>
  )
}

function PaymentOrdersInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initial = parseGasOrderFilters(searchParams)

  const [orders, setOrders] = useState<GasOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState(initial.status)
  // Strict PKR vs crypto separation — crypto payments must never appear in the
  // PKR proof-review flow and vice-versa.
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<GasPaymentType>(initial.paymentType)
  const [chainFilter, setChainFilter] = useState(initial.chain)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [searchInput, setSearchInput] = useState(initial.q)
  const [search, setSearch] = useState(initial.q)

  const [counts, setCounts] = useState<{ active: number; proofs: number; failed: number; refund: number } | null>(null)
  const [chains, setChains] = useState<string[]>([])

  const [confirmRetry, setConfirmRetry] = useState(false)
  const [confirmRefund, setConfirmRefund] = useState(false)
  const [confirmMarkPayment, setConfirmMarkPayment] = useState(false)
  const [confirmApprovePkr, setConfirmApprovePkr] = useState(false)
  const [confirmRejectPkr, setConfirmRejectPkr] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<GasOrder | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  // Debounce free-text search so each keystroke doesn't hit the API.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // Filters are mirrored into the URL so the view is shareable and survives refresh;
  // dashboard / notification deep links arrive pre-filtered.
  useEffect(() => {
    const target = paymentOrdersHref({ status: statusFilter, paymentType: paymentTypeFilter, chain: chainFilter, from, to, q: search })
    const current = searchParams.toString() ? `${PAYMENT_ORDERS_ROUTE}?${searchParams.toString()}` : PAYMENT_ORDERS_ROUTE
    if (target !== current) router.replace(target, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, paymentTypeFilter, chainFilter, from, to, search])

  const fetchOrders = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit: LIMIT }
      if (statusFilter !== 'all') params.status = statusFilter
      if (paymentTypeFilter !== 'all') params.paymentType = paymentTypeFilter
      if (chainFilter) params.chain = chainFilter
      if (from) params.from = from
      if (to) params.to = to
      if (search) params.search = search
      const data = await adminApi.getGasOrders(params) as unknown as GasOrdersResponse
      setOrders(data.orders ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payment orders')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, paymentTypeFilter, chainFilter, from, to, search])

  const fetchSummary = useCallback(async () => {
    try {
      const [stats, proofs] = await Promise.all([
        adminApi.getGasStats() as unknown as Promise<{ pendingCount: number; failedCount: number; refundPendingCount?: number; wallets?: { chain: string }[] }>,
        adminApi.getGasOrders({ status: 'payment_uploaded', paymentType: 'MANUAL', limit: 1 }) as unknown as Promise<GasOrdersResponse>,
      ])
      setCounts({
        active: stats.pendingCount,
        proofs: proofs.pagination?.total ?? 0,
        failed: stats.failedCount,
        refund: stats.refundPendingCount ?? 0,
      })
      setChains((stats.wallets ?? []).map((w) => w.chain))
    } catch { /* summary is non-critical */ }
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([fetchSummary(), fetchOrders()])
  }, [fetchSummary, fetchOrders])

  usePolling(refresh, 30_000)
  // usePolling only runs on mount + interval; refetch immediately on filter/page change.
  useEffect(() => { void fetchOrders() }, [fetchOrders])

  async function run(fn: () => Promise<unknown>, close: () => void, okMsg: string, failMsg: string) {
    setActionError(null)
    setActionSuccess(null)
    try {
      await fn()
      close()
      setActionSuccess(okMsg)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failMsg)
      close()
    }
    void refresh()
  }

  const handleRetry = () => selectedId ? run(() => adminApi.retryGasOrder(selectedId), () => setConfirmRetry(false), 'Gas order queued for retry.', 'Failed to retry gas order') : Promise.resolve()
  const handleRefund = () => selectedId ? run(() => adminApi.refundGasOrder(selectedId), () => setConfirmRefund(false), 'Gas order marked as refunded.', 'Failed to refund gas order') : Promise.resolve()
  const handleApprovePkr = () => selectedId ? run(() => adminApi.approvePkrOrder(selectedId), () => setConfirmApprovePkr(false), 'PKR payment approved — gas delivery queued.', 'Failed to approve PKR order') : Promise.resolve()
  const handleMarkPayment = () => selectedId ? run(() => adminApi.markGasPaymentReceived(selectedId), () => setConfirmMarkPayment(false), 'Payment confirmed — gas delivery queued.', 'Failed to confirm payment') : Promise.resolve()
  const handleRejectPkr = (reason: string) => selectedId ? run(() => adminApi.rejectGasOrder(selectedId, reason), () => setConfirmRejectPkr(false), 'Payment rejected — the order was closed and the customer notified.', 'Failed to reject the payment') : Promise.resolve()

  const apply = (fn: () => void) => { fn(); setPage(1) }
  const filtersActive = statusFilter !== 'all' || paymentTypeFilter !== 'all' || !!chainFilter || !!from || !!to || !!searchInput
  const clearFilters = () => {
    setStatusFilter('all'); setPaymentTypeFilter('all'); setChainFilter(''); setFrom(''); setTo('')
    setSearchInput(''); setSearch(''); setPage(1)
  }
  const totalPages = Math.ceil(total / LIMIT)

  if (loading && orders.length === 0 && !error) return <LoadingState message="Loading payment orders..." />
  if (error && orders.length === 0) return <ErrorState title={error} onRetry={refresh} />

  const summary = [
    { label: 'Active (in flight)', value: counts?.active, status: 'active', pt: 'all' as GasPaymentType, tone: 'text-warning' },
    { label: 'Proofs awaiting review', value: counts?.proofs, status: 'payment_uploaded', pt: 'MANUAL' as GasPaymentType, tone: 'text-primary' },
    { label: 'Failed', value: counts?.failed, status: 'failed', pt: 'all' as GasPaymentType, tone: 'text-danger' },
    { label: 'Refund pending', value: counts?.refund, status: 'refund_pending', pt: 'all' as GasPaymentType, tone: 'text-warning' },
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Payment Orders</h1>
          <p className="text-text-muted text-sm mt-0.5">
            Review payment proofs, approve or reject manual payments, and follow every gas order to delivery or refund.
          </p>
        </div>
        <Link href="/admin/gas" className="text-sm font-medium text-primary hover:underline">Hot wallets &amp; chain health →</Link>
      </div>

      {actionSuccess && <div role="status" className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{actionSuccess}</div>}
      {actionError && <div role="alert" className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{actionError}</div>}

      {/* Summary counts — each opens the matching filtered list. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {summary.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => apply(() => { setStatusFilter(c.status); setPaymentTypeFilter(c.pt) })}
            className="text-left bg-surface shadow-card border border-border rounded-xl p-4 hover:border-primary/40 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">{c.label} <span className="text-primary ml-1">→</span></p>
            <p className={`text-2xl font-bold mt-1 ${(c.value ?? 0) > 0 ? c.tone : 'text-text-primary'}`}>{c.value ?? '—'}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="md:col-span-2 relative block">
            <span className="sr-only">Search orders</span>
            <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search order ref, address, tx hash, user…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </label>
          <label className="block">
            <span className="sr-only">Chain</span>
            <select
              value={chainFilter}
              onChange={(e) => apply(() => setChainFilter(e.target.value))}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">All chains</option>
              {chains.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <input type="date" aria-label="Created from" value={from} onChange={(e) => apply(() => setFrom(e.target.value))}
              className="w-full px-2 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary" />
            <span className="text-text-muted text-xs">to</span>
            <input type="date" aria-label="Created to" value={to} onChange={(e) => apply(() => setTo(e.target.value))}
              className="w-full px-2 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
        </div>

        <div>
          <span className="block text-xs font-semibold text-text-muted mb-1.5">Payment type</span>
          <div className="flex flex-wrap gap-2">
            {PAYMENT_TYPES.map((pt) => (
              <button
                key={pt.v}
                type="button"
                aria-pressed={paymentTypeFilter === pt.v}
                onClick={() => apply(() => setPaymentTypeFilter(pt.v))}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${paymentTypeFilter === pt.v ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-alt'}`}
              >
                {pt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-semibold text-text-muted">Order status</span>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {STATUS_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-text-muted mr-1">{g.label}</span>
                {g.statuses.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={statusFilter === s}
                    onClick={() => apply(() => setStatusFilter(s))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${statusFilter === s ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-alt'}`}
                  >
                    {s === 'all' ? 'All' : s === 'active' ? 'Active (in flight)' : (GAS_STATUS_LABELS[s] ?? s)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {filtersActive && (
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-danger">
            <X className="w-3 h-3" aria-hidden /> Clear all filters
          </button>
        )}
      </div>

      {/* Orders table */}
      {orders.length === 0 ? (
        <EmptyState icon={Fuel} title="No payment orders found" description="No orders match the current filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order Ref</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain / Tier</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">To Address</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Created</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((o) => (
                  <tr key={o.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/gas/orders/${o.orderRef}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {o.orderRef}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <EntityLogo type="chain" slug={o.chain} size="xs" />
                        <Badge variant="outline" size="sm">{o.chain}</Badge>
                        {o.tier && <Badge variant="default" size="sm">{o.tier}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      <span className="font-medium">{fmtNative(o.gasAmountNative)} {CHAIN_SYMBOL[o.chain] ?? o.chain}</span>
                      <span className="text-text-muted text-xs ml-1">/ ${parseFloat(String(o.paymentAmount)).toFixed(2)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {o.toAddress.slice(0, 6)}…{o.toAddress.slice(-4)}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <Badge variant={gasStatusVariant(o.status)} size="sm">{GAS_STATUS_LABELS[o.status] ?? o.status}</Badge>
                        {o.failureReason && (
                          <p className="text-xs text-danger mt-0.5 max-w-[160px] truncate" title={o.failureReason}>{o.failureReason}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={gasOrderHref(o.orderRef)}>
                          <Button size="sm" variant="ghost">View</Button>
                        </Link>
                        {o.status === 'payment_uploaded' && (o.paymentCoin === 'PKR' || o.paymentNetwork === 'EXCHANGE') && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => { setSelectedId(o.id); setSelectedOrder(o); setActionError(null); setConfirmApprovePkr(true) }}
                            >
                              {o.paymentNetwork === 'EXCHANGE' ? 'Approve transfer' : 'Approve PKR'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setSelectedId(o.id); setSelectedOrder(o); setActionError(null); setConfirmRejectPkr(true) }}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {o.status === 'payment_uploaded' && o.paymentCoin !== 'PKR' && o.paymentNetwork !== 'EXCHANGE' && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => { setSelectedId(o.id); setSelectedOrder(o); setActionError(null); setConfirmMarkPayment(true) }}
                            >
                              Confirm Payment
                            </Button>
                          </>
                        )}
                        {isPaidFailed(o) && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => { setSelectedId(o.id); setSelectedOrder(o); setActionError(null); setConfirmRetry(true) }}
                            >
                              Retry
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setSelectedId(o.id); setSelectedOrder(o); setActionError(null); setConfirmRefund(true) }}
                            >
                              Refund
                            </Button>
                          </>
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
              <p className="text-text-muted text-sm">Page {page} of {totalPages} · {total} orders</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <GasPaymentConfirmModal isOpen={confirmMarkPayment} onClose={() => setConfirmMarkPayment(false)} onConfirm={handleMarkPayment} order={selectedOrder} type="usdt" />
      <GasPaymentConfirmModal isOpen={confirmApprovePkr} onClose={() => setConfirmApprovePkr(false)} onConfirm={handleApprovePkr} order={selectedOrder} type="pkr" />
      <RejectProofModal
        isOpen={confirmRejectPkr}
        onClose={() => setConfirmRejectPkr(false)}
        orderRef={selectedOrder?.orderRef ?? ''}
        subject={selectedOrder?.paymentNetwork === 'EXCHANGE' ? 'exchange transfer' : 'payment proof'}
        onConfirm={handleRejectPkr}
      />
      <ConfirmModal
        isOpen={confirmRetry}
        onClose={() => setConfirmRetry(false)}
        onConfirm={handleRetry}
        title="Retry Gas Order"
        description="Re-queue this failed gas order for processing? It will attempt to send gas again."
        confirmLabel="Retry"
        confirmVariant="primary"
      />
      <ConfirmModal
        isOpen={confirmRefund}
        onClose={() => setConfirmRefund(false)}
        onConfirm={handleRefund}
        title="Mark as Refunded"
        description="Mark this order as refunded? The user's USDT must be returned manually via the hot wallet before confirming."
        confirmLabel="Mark Refunded"
        confirmVariant="danger"
      />
    </div>
  )
}
