'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { useLiveData } from '@/hooks/useLiveData'
import { useGasRange, useUrlParams } from '@/hooks/useGasRange'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Flame, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { GAS_STATUS_LABELS, gasStatusLabel } from '@/lib/gasOrderStatus'
import { gasOrderHref } from '@/lib/adminRoutes'
import { GasOrdersTabs } from '@/components/admin/GasOrdersTabs'
import { DataFreshness, GasRangePicker } from '@/components/admin/gas-insights/GasInsightsUI'
import { TradesSummaryStrip } from '@/components/admin/gas-insights/OrdersSummaryStrips'
import type { TradesSummary } from '@/lib/gasInsights'

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

// Client-side "source" classification for each order.
function orderSource(o: AdminGasOrder): 'merchant' | 'free' | 'direct' {
  if (o.merchantApiKeyId) return 'merchant'
  if (o.isFreeGrant) return 'free'
  return 'direct'
}

// Category tabs are the mutually-exclusive order categories (Crypto / PKR / Free Gas, plus
// Unknown for incomplete records). They map straight onto the server `category` filter.
type CategoryTab = 'all' | 'crypto' | 'pkr' | 'free' | 'unknown'
const SOURCE_TABS: { value: CategoryTab; label: string }[] = [
  { value: 'all',    label: 'All' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'pkr',    label: 'PKR' },
  { value: 'free',   label: 'Free Gas' },
]
const isCategoryTab = (v: string | null): v is CategoryTab => !!v && ['all', 'crypto', 'pkr', 'free', 'unknown'].includes(v)
const LIMIT = 20

export default function GasTradesPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading gas trades..." />}>
      <GasTradesInner />
    </Suspense>
  )
}

function GasTradesInner() {
  // Every filter lives in the URL, so the view survives refresh and back/forward navigation.
  const url = useUrlParams()
  const gr = useGasRange()
  const rawTab = url.get('category')
  const sourceTab: CategoryTab = isCategoryTab(rawTab) ? rawTab : 'all'
  const rawStatus = url.get('status')
  const statusFilter = rawStatus && rawStatus in GAS_STATUS_LABELS ? rawStatus : 'all'
  const merchantOnly = url.get('merchant') === '1'
  const filterKey = `${gr.key}|${sourceTab}|${statusFilter}|${merchantOnly}`
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  const setPage = (p: number | ((n: number) => number)) =>
    setPageState({ key: filterKey, page: typeof p === 'function' ? p(page) : p })

  // List and summary come from ONE fetch with ONE resolved date range, so records, totals,
  // cards and the chart always describe the same filtered snapshot. The key changes with every
  // filter, so a stale response from a previous filter can never replace the current one.
  const q = useLiveData(async () => {
    const w = gr.resolve()
    const base: Record<string, string | number | undefined> = { tz: gr.tz, to: w.to }
    if (w.from) base.from = w.from
    if (sourceTab !== 'all') base.category = sourceTab
    if (statusFilter !== 'all') base.status = statusFilter
    if (merchantOnly) base.merchantOnly = 'true'
    const [list, summary] = await Promise.all([
      adminApi.getGasOrders({ ...base, page, limit: LIMIT }),
      adminApi.getGasOrdersSummary({ ...base, view: 'trades' }),
    ])
    return { list: list as unknown as GasOrdersResponse, summary: summary as TradesSummary }
  }, `trades|${filterKey}|${page}`)

  const orders = q.data?.list.orders ?? []
  const total = q.data?.list.pagination?.total ?? 0
  const totalPages = Math.ceil(total / LIMIT)
  const summary = q.data?.summary ?? null
  const unknownCount = summary?.categories.find((c) => c.category === 'unknown')?.count ?? 0
  const tabs = unknownCount > 0 || sourceTab === 'unknown' ? [...SOURCE_TABS, { value: 'unknown' as const, label: 'Unknown' }] : SOURCE_TABS

  const setFilter = (updates: Record<string, string | null>) => { url.set(updates) }
  const refresh = () => { void q.refresh() }

  if (q.error && !q.data) return <ErrorState title={q.error} onRetry={refresh} />

  return (
    <div className="space-y-5">
      <GasOrdersTabs active="trades" />
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Gas Trades</h1>
        <p className="text-text-muted text-sm mt-0.5" aria-live="polite">
          Every gas order — direct user buys, merchant API orders, and free-gas grants.{' '}
          {q.data ? `${total.toLocaleString()} orders in range` : 'Loading…'}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <GasRangePicker range={gr.range} customFrom={gr.customFrom} customTo={gr.customTo} tz={gr.tz} label={gr.resolve().label} onChange={gr.setRange} />
        <DataFreshness updatedAt={q.updatedAt} stale={q.stale} error={q.error} refreshing={q.refreshing} onRefresh={refresh} />
      </div>

      <TradesSummaryStrip summary={summary} error={q.error} onRetry={refresh} analyticsHref={`/admin/gas/insights${gr.carryQuery}`} />

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap items-center gap-3">
        <div className="admin-toolbar gap-2" role="group" aria-label="Order category">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={sourceTab === t.value}
              onClick={() => setFilter({ category: t.value === 'all' ? null : t.value })}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                sourceTab === t.value
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface text-text-secondary border-border hover:bg-surface-alt'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          aria-label="Status"
          value={statusFilter}
          onChange={(e) => setFilter({ status: e.target.value === 'all' ? null : e.target.value })}
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
            onChange={(e) => setFilter({ merchant: e.target.checked ? '1' : null })}
            className="w-4 h-4 accent-primary"
          />
          Merchant orders only
        </label>
      </div>

      {!q.data ? (
        <LoadingState message="Loading gas trades..." />
      ) : orders.length === 0 ? (

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
                          href={gasOrderHref(o.orderRef)}
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
