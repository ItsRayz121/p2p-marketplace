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
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { useAuthStore } from '@/store/auth.store'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GasOrder {
  id: string
  orderRef: string
  tier: string | null
  chain: string
  gasAmountNative: string
  paymentAmount: string
  paymentCoin?: string | null
  pkrAmount?: string | null
  toAddress: string
  status: 'payment_pending' | 'payment_uploaded' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'refunded'
  deliveryTxHash?: string
  failureReason?: string
  createdAt: string
}

interface GasOrdersResponse {
  orders: GasOrder[]
  pagination: { total: number; page: number; limit: number; pages: number }
}

interface GasWallet {
  chain: string
  address: string
  isActive: boolean
  balance: number | null
  balanceUsd: number | null
  nativeSymbol: string
  status: 'healthy' | 'low' | 'paused' | 'unavailable'
  alertThresholdUsd: number | null
  pauseThresholdUsd: number | null
}

interface GasStats {
  todayOrders: number
  todayRevenue: string | number
  pendingCount: number
  failedCount: number
  refundPendingCount: number
  pendingCustomRequests: number
  wallet: GasWallet | null
  wallets: GasWallet[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHAIN_SYMBOL: Record<string, string> = { TRON: 'TRX', BSC: 'BNB', ETHEREUM: 'ETH', ETH: 'ETH' }

function fmtNative(amount: string | number): string {
  const n = parseFloat(String(amount))
  return n >= 1 ? String(Math.round(n)) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering...',
  delivered:        'Delivered',
  expired:          'Expired',
  failed:           'Failed',
  refunded:         'Refunded',
}

function statusVariant(s: string): 'success' | 'danger' | 'warning' | 'default' | 'outline' {
  if (s === 'delivered') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'refunded') return 'warning'
  if (s === 'payment_uploaded') return 'warning'
  if (s === 'payment_detected' || s === 'sending') return 'default'
  return 'outline'
}

function walletStatusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'healthy') return 'success'
  if (s === 'low') return 'warning'
  if (s === 'paused') return 'danger'
  return 'default'
}

function walletStatusLabel(s: string): string {
  const labels: Record<string, string> = {
    healthy:     'Healthy',
    low:         'Low Balance',
    paused:      'Paused',
    unavailable: 'Balance Unknown',
  }
  return labels[s] ?? s
}

// ─── WalletCard ───────────────────────────────────────────────────────────────

function WalletCard({
  wallet, isSuperAdmin, toggling, onToggle, onRefresh, refreshing,
}: {
  wallet: GasWallet
  isSuperAdmin: boolean
  toggling: boolean
  onToggle: () => void
  onRefresh: () => void
  refreshing: boolean
}) {
  return (
    <div className={`bg-white border rounded-xl p-5 ${
      wallet.status === 'paused' ? 'border-danger/40'
      : wallet.status === 'low' ? 'border-warning/40'
      : 'border-border'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-text-primary">{wallet.chain} Hot Wallet</h2>
            <Badge variant={walletStatusVariant(wallet.status)} size="sm">
              {walletStatusLabel(wallet.status)}
            </Badge>
            {!wallet.isActive && <Badge variant="danger" size="sm">Admin Paused</Badge>}
          </div>
          <p className="text-xs font-mono text-text-muted truncate mb-3">{wallet.address}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <div>
              <span className="text-text-muted">Balance: </span>
              <span className={`font-bold ${
                wallet.balance === null ? 'text-text-muted'
                : wallet.status === 'paused' ? 'text-danger'
                : wallet.status === 'low' ? 'text-warning'
                : 'text-success'
              }`}>
                {wallet.balance !== null ? `${fmtNative(wallet.balance)} ${wallet.nativeSymbol}` : 'Unknown'}
                {wallet.balanceUsd != null && <span className="ml-1 font-normal text-text-muted">(${wallet.balanceUsd.toFixed(2)})</span>}
              </span>
            </div>
            {wallet.alertThresholdUsd != null && (
              <div>
                <span className="text-text-muted">Alert at: </span>
                <span className="font-medium text-text-primary">${wallet.alertThresholdUsd}</span>
              </div>
            )}
            {wallet.pauseThresholdUsd != null && (
              <div>
                <span className="text-text-muted">Pause at: </span>
                <span className="font-medium text-text-primary">${wallet.pauseThresholdUsd}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh Balance'}
          </Button>
          {isSuperAdmin && (
            <Button size="sm" variant={wallet.isActive ? 'secondary' : 'primary'} onClick={onToggle} disabled={toggling}>
              {wallet.isActive ? 'Pause Chain' : 'Resume Chain'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasAdminPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  // Stats state
  const [stats, setStats] = useState<GasStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  // Orders state
  const [orders, setOrders] = useState<GasOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('all')

  // Action state
  const [confirmRetry, setConfirmRetry] = useState(false)
  const [confirmRefund, setConfirmRefund] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState<string | null>(null) // chain name or null
  const [confirmApprovePkr, setConfirmApprovePkr] = useState(false)
  const [confirmRejectPkr, setConfirmRejectPkr] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null) // chain being toggled
  const [refreshing, setRefreshing] = useState<string | null>(null) // chain being refreshed

  const limit = 20

  const fetchStats = useCallback(async () => {
    try {
      const data = await adminApi.getGasStats()
      setStats(data)
      setStatsError(null)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load stats')
    }
  }, [])

  const fetchOrders = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getGasOrders(params) as unknown as GasOrdersResponse
      setOrders(data.orders ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load gas orders')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  const refresh = useCallback(async () => {
    await Promise.all([fetchStats(), fetchOrders()])
  }, [fetchStats, fetchOrders])

  usePolling(refresh, 30_000)

  async function handleRetry() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.retryGasOrder(selectedId)
      setConfirmRetry(false)
      setActionSuccess('Gas order queued for retry.')
      void refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to retry gas order')
    }
  }

  async function handleRefund() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.refundGasOrder(selectedId)
      setConfirmRefund(false)
      setActionSuccess('Gas order marked as refunded.')
      void refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to refund gas order')
    }
  }

  async function handleApprovePkr() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.approvePkrOrder(selectedId)
      setConfirmApprovePkr(false)
      setActionSuccess('PKR payment approved — gas delivery queued.')
      void refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve PKR order')
    }
  }

  async function handleRejectPkr() {
    if (!selectedId) return
    setActionError(null)
    try {
      await adminApi.rejectPkrOrder(selectedId)
      setConfirmRejectPkr(false)
      setActionSuccess('PKR payment rejected.')
      void refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject PKR order')
    }
  }

  async function handleToggleChain(chain: string) {
    setToggling(chain)
    setActionError(null)
    try {
      const res = await adminApi.toggleGasChain(chain)
      setConfirmToggle(null)
      setActionSuccess(`${chain} chain is now ${res.isActive ? 'active' : 'paused'}.`)
      void fetchStats()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to toggle chain')
    } finally {
      setToggling(null)
    }
  }

  async function handleRefreshBalance(chain: string) {
    setRefreshing(chain)
    setActionError(null)
    try {
      const res = await adminApi.refreshGasWalletBalance(chain)
      setActionSuccess(`${chain} balance refreshed: ${res.balance.toFixed(6)} ${res.nativeSymbol}`)
      void fetchStats()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to refresh ${chain} balance`)
    } finally {
      setRefreshing(null)
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading && !stats) return <LoadingState message="Loading gas operations..." />
  if (error && orders.length === 0) return <ErrorState title={error} onRetry={refresh} />

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Gas Fee Operations</h1>
          <p className="text-text-muted text-sm mt-0.5">{total} total orders</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/gas/requests">
            <Button size="sm" variant="ghost">Custom Requests</Button>
          </Link>
          <Link href="/admin/gas/chains">
            <Button size="sm" variant="secondary">Chain & Token Config</Button>
          </Link>
        </div>
      </div>

      {/* Alerts */}
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
      {statsError && (
        <div className="px-4 py-3 bg-warning/10 border border-warning/20 rounded-xl text-warning text-sm">
          Stats unavailable: {statsError}
        </div>
      )}

      {/* ── Metrics Bar ─────────────────────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Orders Today</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{stats.todayOrders}</p>
          </div>
          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Revenue Today</p>
            <p className="text-2xl font-bold text-success mt-1">
              ${parseFloat(String(stats.todayRevenue || 0)).toFixed(2)}
            </p>
          </div>
          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Active Orders</p>
            <p className="text-2xl font-bold text-warning mt-1">{stats.pendingCount}</p>
          </div>
          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Failed Orders</p>
            <p className={`text-2xl font-bold mt-1 ${stats.failedCount > 0 ? 'text-danger' : 'text-text-primary'}`}>
              {stats.failedCount}
            </p>
          </div>
          {(stats.refundPendingCount ?? 0) > 0 && (
            <div className="bg-white border border-warning/40 rounded-xl p-4 col-span-2 md:col-span-1">
              <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Refund Pending</p>
              <p className="text-2xl font-bold mt-1 text-warning">{stats.refundPendingCount}</p>
            </div>
          )}
        </div>
      )}

      {/* ── PKR Proof Review Alert ───────────────────────────────────────────── */}
      {orders.some(o => o.status === 'payment_uploaded') && statusFilter === 'all' && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <svg className="w-5 h-5 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span><strong>PKR payments pending review.</strong> Orders with &ldquo;Proof Submitted&rdquo; status need approval before gas is released.</span>
          <button onClick={() => setStatusFilter('payment_uploaded')} className="ml-auto text-xs font-bold border border-amber-400 rounded-lg px-2.5 py-1 hover:bg-amber-100">
            View All →
          </button>
        </div>
      )}

      {/* ── Custom Gas Requests Alert ────────────────────────────────────────── */}
      {(stats?.pendingCustomRequests ?? 0) > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
          <svg className="w-5 h-5 flex-shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
          <span><strong>{stats!.pendingCustomRequests} custom gas request{stats!.pendingCustomRequests > 1 ? 's' : ''} pending review.</strong> Users have submitted unsupported chain requests.</span>
          <Link href="/admin/gas/requests" className="ml-auto text-xs font-bold border border-blue-400 rounded-lg px-2.5 py-1 hover:bg-blue-100">
            Review →
          </Link>
        </div>
      )}

      {/* ── Critical Wallet Alert ────────────────────────────────────────────── */}
      {stats?.wallets?.some(w => w.status === 'paused') && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          <svg className="w-5 h-5 flex-shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span>
            <strong>Hot wallet paused:</strong>{' '}
            {stats.wallets.filter(w => w.status === 'paused').map(w => w.chain).join(', ')}.
            {' '}New orders are paused on these chains.
          </span>
        </div>
      )}

      {/* ── Hot Wallet Cards ─────────────────────────────────────────────────── */}
      {(stats?.wallets?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {stats!.wallets.map((w) => (
            <WalletCard
              key={w.chain}
              wallet={w}
              isSuperAdmin={isSuperAdmin}
              toggling={toggling === w.chain}
              onToggle={() => { setActionError(null); setConfirmToggle(w.chain) }}
              onRefresh={() => handleRefreshBalance(w.chain)}
              refreshing={refreshing === w.chain}
            />
          ))}
        </div>
      )}

      {/* ── Status Filters ───────────────────────────────────────────────────── */}
      <div className="bg-white p-4 rounded-xl border border-border flex flex-wrap gap-2">
        {['all', 'payment_pending', 'payment_uploaded', 'payment_detected', 'sending', 'delivered', 'expired', 'failed', 'refunded'].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
              statusFilter === s
                ? 'bg-primary text-white border-primary'
                : 'bg-white text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {s === 'all' ? 'All' : (STATUS_LABELS[s] ?? s)}
          </button>
        ))}
      </div>

      {/* ── Orders Table ─────────────────────────────────────────────────────── */}
      {orders.length === 0 ? (
        <EmptyState title="No gas orders found" description="No gas orders match the current filter." />
      ) : (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
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
                        <Badge variant="outline" size="sm">{o.chain}</Badge>
                        {o.tier && <Badge variant="default" size="sm">{o.tier}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      <span className="font-medium">{fmtNative(o.gasAmountNative)} {CHAIN_SYMBOL[o.chain] ?? o.chain}</span>
                      <span className="text-text-muted text-xs ml-1">/ ${parseFloat(String(o.paymentAmount)).toFixed(2)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                      {o.toAddress.slice(0, 8)}...{o.toAddress.slice(-6)}
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <Badge variant={statusVariant(o.status)} size="sm">{STATUS_LABELS[o.status] ?? o.status}</Badge>
                        {o.failureReason && (
                          <p className="text-xs text-danger mt-0.5 max-w-xs truncate">{o.failureReason}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link href={`/admin/gas/orders/${o.orderRef}`}>
                          <Button size="sm" variant="ghost">View</Button>
                        </Link>
                        {o.status === 'payment_uploaded' && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmApprovePkr(true) }}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmRejectPkr(true) }}
                            >
                              Reject
                            </Button>
                          </>
                        )}
                        {o.status === 'failed' && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmRetry(true) }}
                            >
                              Retry
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setSelectedId(o.id); setActionError(null); setConfirmRefund(true) }}
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
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      <ConfirmModal
        isOpen={confirmApprovePkr}
        onClose={() => setConfirmApprovePkr(false)}
        onConfirm={handleApprovePkr}
        title="Approve PKR Payment"
        description="Confirm you have received the PKR payment and approve this order. Gas delivery will be queued immediately."
        confirmLabel="Approve & Release Gas"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmRejectPkr}
        onClose={() => setConfirmRejectPkr(false)}
        onConfirm={handleRejectPkr}
        title="Reject PKR Payment"
        description="Reject this PKR payment proof. The order will be marked as failed. Inform the user if a refund is required."
        confirmLabel="Reject Payment"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={confirmRetry}
        onClose={() => setConfirmRetry(false)}
        onConfirm={handleRetry}
        title="Retry Gas Order"
        description="Re-queue this failed gas order for processing? It will attempt to send TRX again."
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

      {confirmToggle && (() => {
        const toggleWallet = stats?.wallets?.find((w) => w.chain === confirmToggle)
        if (!toggleWallet) return null
        return (
          <ConfirmModal
            isOpen={true}
            onClose={() => setConfirmToggle(null)}
            onConfirm={() => handleToggleChain(confirmToggle)}
            title={toggleWallet.isActive ? `Pause ${toggleWallet.chain} Chain` : `Resume ${toggleWallet.chain} Chain`}
            description={
              toggleWallet.isActive
                ? `Pausing ${toggleWallet.chain} will prevent new gas orders from being created. Existing orders continue processing.`
                : `Resuming ${toggleWallet.chain} will allow new gas orders again. Ensure the hot wallet has sufficient balance first.`
            }
            confirmLabel={toggleWallet.isActive ? 'Pause Chain' : 'Resume Chain'}
            confirmVariant={toggleWallet.isActive ? 'danger' : 'primary'}
          />
        )
      })()}
    </div>
  )
}
