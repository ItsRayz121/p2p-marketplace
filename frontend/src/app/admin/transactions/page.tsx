'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, ExternalLink, Search } from 'lucide-react'
import { adminApi, type WalletTransaction, type WalletTransactionsResponse, type WalletTxStatusGroup } from '@/lib/api'
import { ADMIN_ROUTES, transactionsHref, type TxDirectionFilter } from '@/lib/adminRoutes'
import { explorerTxUrl } from '@/lib/explorers'
import { fmtAddress, fmtDateTime } from '@/lib/fmt'
import { cn } from '@/lib/utils'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import DepositsPanel from '@/components/admin/DepositsPanel'
import WithdrawalsPanel from '@/components/admin/WithdrawalsPanel'

// ─── Display helpers ───────────────────────────────────────────────────────────

const DIRECTIONS: { value: TxDirectionFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'In · Deposits' },
  { value: 'out', label: 'Out · Withdrawals' },
]

const STATUS_OPTIONS: { value: '' | WalletTxStatusGroup; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'pending', label: 'Pending' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'failed', label: 'Rejected / failed' },
]

const SOURCE_OPTIONS: { value: '' | 'onchain' | 'auto' | 'manual'; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'onchain', label: 'On-chain deposit' },
  { value: 'auto', label: 'Auto-sent withdrawal' },
  { value: 'manual', label: 'Reviewed withdrawal' },
]

const SOURCE_LABEL: Record<WalletTransaction['source'], string> = {
  onchain: 'On-chain deposit',
  auto: 'Auto withdrawal',
  manual: 'Reviewed withdrawal',
}

const STATUS_VARIANT: Record<WalletTxStatusGroup, BadgeVariant> = {
  completed: 'success',
  pending: 'warning',
  on_hold: 'danger',
  failed: 'danger',
}

const CHAIN_LABEL: Record<string, string> = {
  bsc: 'BNB Chain', ethereum: 'Ethereum', tron: 'TRON', base: 'Base', polygon: 'Polygon',
  arbitrum: 'Arbitrum', optimism: 'Optimism', aptos: 'Aptos',
}
const chainLabel = (c: string) => CHAIN_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1)

// Explorer helpers key off the withdrawal network label.
const CHAIN_NETWORK: Record<string, string> = {
  bsc: 'BEP20', ethereum: 'ERC20', tron: 'TRC20', base: 'BASE', polygon: 'POLYGON',
  arbitrum: 'ARBITRUM', optimism: 'OPTIMISM', aptos: 'APTOS',
}

const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
] as const
type RangeValue = (typeof RANGES)[number]['value']

const fmtAmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString()
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString()
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ─── In vs Out chart (real series from the backend, inline SVG) ────────────────

function FlowChart({ series, bucket, asset }: { series: WalletTransactionsResponse['summary']['series']; bucket: 'day' | 'month'; asset: string }) {
  if (series.length === 0) {
    return <p className="text-sm text-text-muted py-10 text-center">No completed {asset} movements in this range.</p>
  }
  const max = Math.max(...series.flatMap((p) => [p.in, p.out]), 1)
  const W = 720, H = 160, padL = 4, padB = 22
  const slot = (W - padL) / series.length
  const barW = Math.max(2, Math.min(18, slot / 2.6))
  const label = (t: string) => {
    const d = new Date(t)
    return bucket === 'month' ? d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  const step = Math.ceil(series.length / 8)
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" role="img" aria-label={`Incoming versus outgoing ${asset} per ${bucket}`}>
        {series.map((p, i) => {
          const x = padL + i * slot + slot / 2
          const hIn = ((H - padB) * p.in) / max
          const hOut = ((H - padB) * p.out) / max
          return (
            <g key={p.t}>
              <title>{`${label(p.t)} — In ${fmtAmt(p.in)} ${asset}, Out ${fmtAmt(p.out)} ${asset}`}</title>
              <rect x={x - barW - 1} y={H - padB - hIn} width={barW} height={hIn} rx={2} className="fill-success" />
              <rect x={x + 1} y={H - padB - hOut} width={barW} height={hOut} rx={2} className="fill-primary" />
              {i % step === 0 && (
                <text x={x} y={H - 6} textAnchor="middle" className="fill-text-muted" fontSize={10}>{label(p.t)}</text>
              )}
            </g>
          )
        })}
        <line x1={0} x2={W} y1={H - padB} y2={H - padB} className="stroke-border" />
      </svg>
      <div className="flex items-center gap-4 text-xs text-text-muted mt-1">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-success" /> In (deposits)</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-primary" /> Out (withdrawals)</span>
        <span className="ml-auto">per {bucket}</span>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'in' | 'out' | 'net' }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', tone === 'in' && 'text-success', tone === 'out' && 'text-primary', tone === 'net' && 'text-text-primary')}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

// ─── Ledger ────────────────────────────────────────────────────────────────────

function Ledger({ direction, onDirection }: { direction: TxDirectionFilter; onDirection: (d: TxDirectionFilter) => void }) {
  const [range, setRange] = useState<RangeValue>('30')
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 30 * 86_400_000)))
  const [to, setTo] = useState(() => isoDay(new Date()))
  const [chain, setChain] = useState('')
  const [status, setStatus] = useState<'' | WalletTxStatusGroup>('')
  const [source, setSource] = useState<'' | 'onchain' | 'auto' | 'manual'>('')
  const [asset, setAsset] = useState('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<WalletTransactionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const limit = 25

  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [qInput])

  const pickRange = (value: RangeValue) => {
    setRange(value)
    setPage(1)
    if (value === 'all' || value === 'custom') return
    setFrom(isoDay(new Date(Date.now() - Number(value) * 86_400_000)))
    setTo(isoDay(new Date()))
  }

  const params = useMemo(() => {
    const p: Record<string, string | number> = { direction, page, limit }
    if (chain) p.chain = chain
    if (status) p.status = status
    if (source) p.source = source
    if (asset) p.asset = asset
    if (q) p.q = q
    if (range !== 'all') {
      if (from) p.from = dayStart(from)
      if (to) p.to = dayEnd(to)
    }
    return p
  }, [direction, page, chain, status, source, asset, q, range, from, to])

  const fetchData = useCallback(async () => {
    try {
      setData(await adminApi.getWalletTransactions(params))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }, [params])

  usePolling(fetchData, 30_000, true, [fetchData])

  const summary = data?.summary
  const activeAsset = summary?.asset ?? 'USDT'
  const rows = data?.transactions ?? []
  const pages = data?.pagination.pages ?? 1

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="admin-toolbar gap-1 p-1 rounded-xl border border-border" role="group" aria-label="Direction">
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={direction === d.value}
                onClick={() => { onDirection(d.value); setPage(1) }}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                  direction === d.value ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search tx hash, address, order ref, user…"
              aria-label="Search transactions"
              className="w-full pl-8 pr-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select value={chain} onChange={(e) => { setChain(e.target.value); setPage(1) }} aria-label="Chain" className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary">
            <option value="">All chains</option>
            {(summary?.chains ?? []).map((c) => <option key={c} value={c}>{chainLabel(c)}</option>)}
          </select>
          <select value={source} onChange={(e) => { setSource(e.target.value as typeof source); setPage(1) }} aria-label="Type" className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary">
            {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1) }} aria-label="Status" className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary">
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div className="admin-toolbar gap-1 p-1 rounded-xl border border-border" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={range === r.value}
                onClick={() => pickRange(r.value)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                  range === r.value ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          {range === 'custom' && (
            <div className="flex items-center gap-2 text-sm">
              <input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="From date" className="px-2 py-1.5 border border-border rounded-lg bg-surface text-text-primary" />
              <span className="text-text-muted">→</span>
              <input type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="To date" className="px-2 py-1.5 border border-border rounded-lg bg-surface text-text-primary" />
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <LoadingState message="Loading transactions..." />
      ) : error && !data ? (
        <ErrorState title={error} onRetry={fetchData} />
      ) : (
        <>
          {/* Summary + chart */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-text-muted">
                Completed movements in the selected range, for one asset (mixed units are never added together).
              </p>
              {summary && summary.assets.length > 1 && (
                <select value={activeAsset} onChange={(e) => { setAsset(e.target.value); setPage(1) }} aria-label="Summary asset" className="px-3 py-1.5 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary">
                  {summary.assets.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              )}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <SummaryCard label="Total In" tone="in" value={`${fmtAmt(summary?.totalIn ?? 0)} ${activeAsset}`} sub={`${summary?.countIn ?? 0} deposits credited`} />
              <SummaryCard label="Total Out" tone="out" value={`${fmtAmt(summary?.totalOut ?? 0)} ${activeAsset}`} sub={`${summary?.countOut ?? 0} withdrawals sent`} />
              <SummaryCard label="Net Flow" tone="net" value={`${(summary?.net ?? 0) >= 0 ? '+' : '−'}${fmtAmt(Math.abs(summary?.net ?? 0))} ${activeAsset}`} sub="In minus out" />
              <SummaryCard label="Pending" value={String(summary?.pendingCount ?? 0)} sub="awaiting credit / approval / send" />
            </div>
            <div className="bg-surface shadow-card border border-border rounded-xl p-4">
              <FlowChart series={summary?.series ?? []} bucket={summary?.bucket ?? 'day'} asset={activeAsset} />
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState icon={ArrowLeftRight} title="No transactions found" description="Nothing matches the current filters." />
          ) : (
            <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm stack-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Direction</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Tx Hash</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">User / Order</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Type</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Time</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((t) => {
                      const url = t.txHash ? explorerTxUrl(CHAIN_NETWORK[t.chain] ?? t.network ?? '', t.txHash) : null
                      const isIn = t.direction === 'in'
                      return (
                        <tr key={t.key} className="hover:bg-surface/50 transition-colors align-middle">
                          <td className="px-4 py-3" data-label="Direction">
                            <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', isIn ? 'text-success' : 'text-primary')}>
                              {isIn ? <ArrowDownToLine size={14} aria-hidden /> : <ArrowUpFromLine size={14} aria-hidden />}
                              {isIn ? 'IN · Deposit' : 'OUT · Withdrawal'}
                            </span>
                          </td>
                          <td className="px-4 py-3" data-label="Amount">
                            <p className={cn('font-semibold', isIn ? 'text-success' : 'text-text-primary')}>
                              {isIn ? '+' : '−'}{Number(t.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} {t.asset}
                            </p>
                            {t.amountUsd && <p className="text-xs text-text-muted">≈ ${Number(t.amountUsd).toFixed(2)}</p>}
                          </td>
                          <td className="px-4 py-3 text-text-primary" data-label="Chain">
                            {chainLabel(t.chain)}
                            {t.network && <span className="text-xs text-text-muted"> · {t.network}</span>}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs" data-label="Tx Hash">
                            {t.txHash ? (
                              url ? (
                                <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1" title={t.txHash}>
                                  {fmtAddress(t.txHash, 8, 6)} <ExternalLink size={11} className="opacity-60" />
                                </a>
                              ) : <span title={t.txHash}>{fmtAddress(t.txHash, 8, 6)}</span>
                            ) : <span className="text-text-muted">—</span>}
                            {t.address && <p className="text-text-muted mt-0.5" title={t.address}>{isIn ? 'from' : 'to'} {fmtAddress(t.address, 6, 4)}</p>}
                          </td>
                          <td className="px-4 py-3" data-label="User / Order">
                            {t.user ? (
                              <Link href={`/admin/users/${t.user.id}`} className="text-primary hover:underline">{t.user.username ?? t.user.email ?? 'user'}</Link>
                            ) : <span className="text-text-muted">—</span>}
                            {t.relatedOrder && <p className="font-mono text-xs text-text-muted mt-0.5">{t.relatedOrder}</p>}
                          </td>
                          <td className="px-4 py-3 text-text-secondary text-xs" data-label="Type">{SOURCE_LABEL[t.source]}</td>
                          <td className="px-4 py-3" data-label="Status">
                            <Badge variant={STATUS_VARIANT[t.statusGroup]} size="sm">{t.status.replace(/_/g, ' ')}</Badge>
                          </td>
                          <td className="px-4 py-3 text-text-secondary whitespace-nowrap" data-label="Time">{fmtDateTime(t.createdAt)}</td>
                          <td className="px-4 py-3 text-right" data-label="">
                            <Link href={t.kind === 'withdrawal' ? `${ADMIN_ROUTES.withdrawals}/${t.id}` : `${transactionsHref('in')}&view=queue`}>
                              <Button size="sm" variant="ghost">{t.kind === 'withdrawal' ? 'View' : 'Review'}</Button>
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                  <p className="text-text-muted text-sm">Page {page} of {pages} · {data?.pagination.total.toLocaleString()} transactions</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                    <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

function TransactionsView() {
  const router = useRouter()
  const params = useSearchParams()
  const rawDirection = params.get('direction')
  const direction: TxDirectionFilter = rawDirection === 'in' || rawDirection === 'out' ? rawDirection : 'all'
  const view = params.get('view') === 'queue' ? 'queue' : 'ledger'

  const go = (next: { direction?: TxDirectionFilter; view?: 'ledger' | 'queue' }) => {
    const qs = new URLSearchParams()
    const d = next.direction ?? direction
    const v = next.view ?? view
    if (d !== 'all') qs.set('direction', d)
    if (v === 'queue') qs.set('view', 'queue')
    const s = qs.toString()
    router.replace(s ? `${ADMIN_ROUTES.transactions}?${s}` : ADMIN_ROUTES.transactions, { scroll: false })
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Deposits &amp; Withdrawals</h1>
          <p className="text-text-muted text-sm mt-0.5">
            Every incoming deposit and outgoing withdrawal in one ledger, with the review queues for approving and crediting.
          </p>
        </div>
        <div className="admin-toolbar gap-1 p-1 rounded-xl border border-border" role="group" aria-label="View">
          {(['ledger', 'queue'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => go({ view: v, ...(v === 'queue' && direction === 'all' ? { direction: 'out' as const } : {}) })}
              className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors', view === v ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary')}
            >
              {v === 'ledger' ? 'Ledger' : 'Review queue'}
            </button>
          ))}
        </div>
      </div>

      {view === 'ledger' ? (
        <Ledger direction={direction} onDirection={(d) => go({ direction: d })} />
      ) : (
        <div className="space-y-4">
          <div className="admin-toolbar gap-1 p-1 rounded-xl border border-border max-w-full w-fit" role="group" aria-label="Queue">
            {([['in', 'Deposits'], ['out', 'Withdrawals']] as const).map(([d, label]) => (
              <button
                key={d}
                type="button"
                aria-pressed={direction === d}
                onClick={() => go({ direction: d })}
                className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors', direction === d ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary')}
              >
                {label}
              </button>
            ))}
          </div>
          {direction === 'in' ? <DepositsPanel /> : <WithdrawalsPanel />}
        </div>
      )}
    </div>
  )
}

export default function AdminTransactionsPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading transactions..." />}>
      <TransactionsView />
    </Suspense>
  )
}
