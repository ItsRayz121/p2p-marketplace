'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

type Activity = {
  id: string
  orderRef: string
  chain: string
  paymentAmount: string
  paymentCoin: string | null
  paymentNetwork: string | null
  paymentTxHash: string | null
  paymentSenderAddress: string | null
  deliveryTxHash: string | null
  gasAmountNative: string
  toAddress: string
  fromHotWallet: string | null
  status: string
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}

const STATUS_COLORS: Record<string, string> = {
  delivered:        'text-success',
  payment_detected: 'text-blue-600',
  payment_pending:  'text-amber-600',
  payment_uploaded: 'text-amber-600',
  sending:          'text-blue-600',
  failed:           'text-danger',
  expired:          'text-text-muted',
  refunded:         'text-warning',
}

const STATUS_LABELS: Record<string, string> = {
  delivered:        'Delivered',
  payment_detected: 'Payment Detected',
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  sending:          'Sending Gas',
  failed:           'Failed',
  expired:          'Expired',
  refunded:         'Refunded',
}

const CHAINS = ['TRON', 'BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX', 'APT']

function shortHash(h: string) {
  return `${h.slice(0, 8)}…${h.slice(-6)}`
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
}

export default function GasWalletActivityPage() {
  const [items, setItems]     = useState<Activity[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [search, setSearch]     = useState('')
  const [chain, setChain]       = useState('')
  const [status, setStatus]     = useState('')
  const [from, setFrom]         = useState('')
  const [to, setTo]             = useState('')
  const [draftSearch, setDraftSearch] = useState('')

  const LIMIT = 25

  const fetchActivity = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number> = { page: p, limit: LIMIT }
      if (search)  params.search = search
      if (chain)   params.chain  = chain
      if (status)  params.status = status
      if (from)    params.from   = from
      if (to)      params.to     = to
      const res = await adminApi.getGasWalletActivity(params)
      setItems(res.activity)
      setTotal(res.pagination.total)
      setPage(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet activity')
    } finally {
      setLoading(false)
    }
  }, [search, chain, status, from, to])

  useEffect(() => { void fetchActivity(1) }, [fetchActivity])

  function applySearch() {
    setSearch(draftSearch)
  }

  function clearFilters() {
    setSearch(''); setDraftSearch(''); setChain(''); setStatus(''); setFrom(''); setTo('')
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Gas Wallet Activity</h1>
          <p className="text-text-muted text-sm mt-0.5">
            All incoming hot-wallet deposits and outgoing gas deliveries.
          </p>
        </div>
        <p className="text-sm text-text-muted">{total.toLocaleString()} records</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-border p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 flex gap-2">
            <input
              className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
              placeholder="Search order ref, tx hash, address…"
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            />
            <Button size="sm" onClick={applySearch}>Search</Button>
          </div>
          <select
            className="border border-border rounded-lg px-3 py-2 text-sm"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
          >
            <option value="">All chains</option>
            {CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            className="border border-border rounded-lg px-3 py-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              type="date"
              className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              title="From date"
            />
            <input
              type="date"
              className="flex-1 border border-border rounded-lg px-3 py-2 text-sm"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              title="To date"
            />
          </div>
        </div>
        {(search || chain || status || from || to) && (
          <button
            onClick={clearFilters}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{error}</div>
      )}

      {loading && <LoadingState message="Loading wallet activity…" />}
      {!loading && error && <ErrorState title={error} onRetry={() => fetchActivity(page)} />}
      {!loading && !error && items.length === 0 && (
        <EmptyState title="No wallet activity" description="No matching transactions found. Try adjusting filters." />
      )}

      {!loading && items.length > 0 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Deposit (In)</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Delivery (Out)</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((tx) => {
                  const hasDeposit  = !!tx.paymentTxHash
                  const hasDelivery = !!tx.deliveryTxHash

                  return (
                    <tr key={tx.id} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/gas/orders/${tx.orderRef}`}
                          className="font-mono text-xs text-primary hover:underline font-semibold"
                        >
                          {tx.orderRef}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="default" size="sm">{tx.chain}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {hasDeposit ? (
                          <div className="space-y-0.5">
                            <p className="text-xs font-semibold text-blue-700">
                              ↓ {parseFloat(tx.paymentAmount).toFixed(4)} {tx.paymentCoin ?? 'USDT'}
                              {tx.paymentNetwork && (
                                <span className="ml-1 text-text-muted font-normal">({tx.paymentNetwork})</span>
                              )}
                            </p>
                            <p className="font-mono text-[10px] text-text-muted">{shortHash(tx.paymentTxHash!)}</p>
                            {tx.paymentSenderAddress && (
                              <p className="font-mono text-[10px] text-text-muted truncate max-w-[160px]" title={tx.paymentSenderAddress}>
                                from {shortHash(tx.paymentSenderAddress)}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {hasDelivery ? (
                          <div className="space-y-0.5">
                            <p className="text-xs font-semibold text-orange-700">
                              ↑ {parseFloat(tx.gasAmountNative).toFixed(6)} {tx.chain}
                            </p>
                            <p className="font-mono text-[10px] text-text-muted">{shortHash(tx.deliveryTxHash!)}</p>
                            <p className="font-mono text-[10px] text-text-muted truncate max-w-[160px]" title={tx.toAddress}>
                              to {shortHash(tx.toAddress)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('text-xs font-semibold', STATUS_COLORS[tx.status] ?? 'text-text-muted')}>
                          {STATUS_LABELS[tx.status] ?? tx.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">
                        {fmt(tx.updatedAt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => fetchActivity(page - 1)}>Prev</Button>
          <span className="text-sm text-text-muted">Page {page} / {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => fetchActivity(page + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
