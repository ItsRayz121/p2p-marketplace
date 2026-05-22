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

type LedgerEntry = {
  id: string
  entryType: string
  chain: string
  nativeAmount: string
  nativeSymbol: string
  usdAmount: string
  txHash: string | null
  fromAddress: string | null
  toAddress: string | null
  notes: string | null
  createdAt: string
  relatedOrder: { orderRef: string; status: string; paymentCoin: string; paymentNetwork: string } | null
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  order_payment:               'User Payment',
  gas_delivery:                'Gas Delivery',
  delivery_refund:             'Refund',
  refill_hot_from_treasury:    'Treasury Refill',
  drain_hot_to_treasury:       'Drain to Treasury',
  platform_fee:                'Platform Fee',
  external_hot_wallet_deposit: 'Hot Wallet Deposit',
}

const ENTRY_TYPE_COLORS: Record<string, string> = {
  order_payment:               'text-blue-700 bg-blue-50',
  gas_delivery:                'text-orange-700 bg-orange-50',
  delivery_refund:             'text-warning bg-warning/10',
  refill_hot_from_treasury:    'text-success bg-success/10',
  drain_hot_to_treasury:       'text-danger bg-danger/10',
  platform_fee:                'text-text-muted bg-surface',
  external_hot_wallet_deposit: 'text-purple-700 bg-purple-50',
}

const CHAINS = ['TRON', 'BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX', 'APT']

const ENTRY_TYPES = Object.keys(ENTRY_TYPE_LABELS)

function shortHash(h: string) {
  if (h.length <= 16) return h
  return `${h.slice(0, 8)}…${h.slice(-6)}`
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
}

function isInflow(entryType: string) {
  return ['order_payment', 'refill_hot_from_treasury', 'external_hot_wallet_deposit'].includes(entryType)
}

export default function GasWalletActivityPage() {
  const [items, setItems]     = useState<LedgerEntry[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch]     = useState('')
  const [chain, setChain]       = useState('')
  const [entryType, setEntryType] = useState('')
  const [from, setFrom]         = useState('')
  const [to, setTo]             = useState('')

  const LIMIT = 25

  const fetchActivity = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number> = { page: p, limit: LIMIT }
      if (search)    params.search    = search
      if (chain)     params.chain     = chain
      if (entryType) params.entryType = entryType
      if (from)      params.from      = from
      if (to)        params.to        = to
      const res = await adminApi.getGasWalletActivity(params)
      setItems(res.activity)
      setTotal(res.pagination.total)
      setPage(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet activity')
    } finally {
      setLoading(false)
    }
  }, [search, chain, entryType, from, to])

  useEffect(() => { void fetchActivity(1) }, [fetchActivity])

  function applySearch() { setSearch(draftSearch) }

  function clearFilters() {
    setSearch(''); setDraftSearch(''); setChain(''); setEntryType(''); setFrom(''); setTo('')
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Gas Wallet Activity</h1>
          <p className="text-text-muted text-sm mt-0.5">
            All hot-wallet financial movements — deposits, deliveries, refills, and top-ups.
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
              placeholder="Search tx hash, address, notes…"
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
            value={entryType}
            onChange={(e) => setEntryType(e.target.value)}
          >
            <option value="">All types</option>
            {ENTRY_TYPES.map((t) => (
              <option key={t} value={t}>{ENTRY_TYPE_LABELS[t]}</option>
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
        {(search || chain || entryType || from || to) && (
          <button onClick={clearFilters} className="mt-2 text-xs text-primary hover:underline">
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
        <EmptyState title="No wallet activity" description="No matching ledger entries found. Try adjusting filters." />
      )}

      {!loading && items.length > 0 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tx Hash</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">From / To</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((entry) => {
                  const amount    = parseFloat(entry.nativeAmount)
                  const inflow    = isInflow(entry.entryType)
                  const amountAbs = Math.abs(amount)
                  const usd       = parseFloat(entry.usdAmount)

                  return (
                    <tr key={entry.id} className="hover:bg-surface/50 transition-colors">
                      {/* Type */}
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide whitespace-nowrap',
                          ENTRY_TYPE_COLORS[entry.entryType] ?? 'text-text-muted bg-surface',
                        )}>
                          {ENTRY_TYPE_LABELS[entry.entryType] ?? entry.entryType}
                        </span>
                      </td>

                      {/* Chain */}
                      <td className="px-4 py-3">
                        <Badge variant="default" size="sm">{entry.chain}</Badge>
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-3">
                        <p className={cn(
                          'text-sm font-semibold',
                          inflow ? 'text-success' : 'text-danger',
                        )}>
                          {inflow ? '+' : '−'}{amountAbs.toFixed(6)} {entry.nativeSymbol}
                        </p>
                        {usd > 0 && (
                          <p className="text-[10px] text-text-muted">${usd.toFixed(4)}</p>
                        )}
                      </td>

                      {/* Tx Hash */}
                      <td className="px-4 py-3">
                        {entry.txHash ? (
                          <span className="font-mono text-[11px] text-text-secondary" title={entry.txHash}>
                            {shortHash(entry.txHash)}
                          </span>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>

                      {/* From / To */}
                      <td className="px-4 py-3 max-w-[180px]">
                        {entry.fromAddress && (
                          <p className="font-mono text-[10px] text-text-muted truncate" title={entry.fromAddress}>
                            from {shortHash(entry.fromAddress)}
                          </p>
                        )}
                        {entry.toAddress && (
                          <p className="font-mono text-[10px] text-text-muted truncate" title={entry.toAddress}>
                            to {shortHash(entry.toAddress)}
                          </p>
                        )}
                        {!entry.fromAddress && !entry.toAddress && (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>

                      {/* Related order */}
                      <td className="px-4 py-3">
                        {entry.relatedOrder ? (
                          <Link
                            href={`/admin/gas/orders/${entry.relatedOrder.orderRef}`}
                            className="font-mono text-xs text-primary hover:underline font-semibold"
                          >
                            {entry.relatedOrder.orderRef}
                          </Link>
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>

                      {/* Time */}
                      <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">
                        {fmt(entry.createdAt)}
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
