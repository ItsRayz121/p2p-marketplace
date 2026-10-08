'use client'
import { useState, useCallback, useEffect } from 'react'
import { Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { adminApi, apiRequest, type GasFinancialKpi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { Badge } from '@/components/ui/Badge'
import { Fuel } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
import { useAuthStore } from '@/store/auth.store'
import { chainDisplayName } from '@/lib/chainDisplayName'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { paymentOrdersHref, parseGasOrderFilters } from '@/lib/adminRoutes'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GasWallet {
  chain: string
  address: string
  friendlyAddress?: string | null
  isActive: boolean
  balance: number | null
  balanceUsd: number | null
  nativeSymbol: string
  status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable'
  pauseReason: 'manual' | 'low_balance' | null
  alertThresholdUsd: number | null
  pauseThresholdUsd: number | null
  lastBalanceRefreshAt: string | null
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
  aptosGas?: { address: string; balance: number | null; minApt: number; lowApt: boolean } | null
  today:   GasFinancialKpi
  allTime: GasFinancialKpi
}

interface RpcTestResult {
  chain: string
  rpc: { reachable: boolean; blockNumber: number | null; latencyMs: number; isStale: boolean; error: string | null }
  signer: { ok: boolean; derivedAddress: string | null; walletAddress: string; addressMatch: boolean | null; error: string | null }
  allClear: boolean
}

interface GasAnalytics {
  period: string
  successCount: number
  failedCount: number
  avgCompletionSec: number | null
  chainStats: Array<{ chain: string; delivered: number; failed: number; total: number; successRate: number | null }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────


function fmtNative(amount: string | number): string {
  const n = parseFloat(String(amount))
  return n >= 1 ? String(Math.round(n)) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtSeconds(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return fmtDate(iso)
}

function walletStatusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'healthy') return 'success'
  if (s === 'low') return 'warning'
  if (s === 'price_unavailable') return 'warning'
  if (s === 'paused' || s === 'rpc_error') return 'danger'
  return 'default'
}

function walletStatusLabel(s: string, pauseReason?: string | null): string {
  if (s === 'paused' && pauseReason === 'manual') return 'Manually Paused'
  if (s === 'paused' && pauseReason === 'low_balance') return 'Low Balance Paused'
  const labels: Record<string, string> = {
    healthy:           'Healthy',
    low:               'Low Balance',
    paused:            'Paused',
    unavailable:       'Balance Unknown',
    rpc_error:         'RPC Error',
    price_unavailable: 'Price Unavailable',
  }
  return labels[s] ?? s
}

function walletHealthDot(s: string): string {
  if (s === 'healthy') return 'bg-green-500'
  if (s === 'low') return 'bg-yellow-400'
  if (s === 'price_unavailable') return 'bg-orange-400'
  if (s === 'paused' || s === 'rpc_error') return 'bg-red-500'
  return 'bg-border-strong'
}

function estimatedDeliveries(wallet: GasWallet): number | null {
  if (wallet.balanceUsd === null || wallet.balanceUsd <= 0) return null
  // Heuristic average gas cost per delivery: $0.15 (covers all chains)
  // This is a rough estimate — replace with chain-specific actuals once tracked
  const AVG_GAS_COST_USD = 0.15
  return Math.floor(wallet.balanceUsd / AVG_GAS_COST_USD)
}

// ─── RPC Test Modal ───────────────────────────────────────────────────────────

function RpcTestModal({ result, onClose }: { result: RpcTestResult; onClose: () => void }) {
  const row = (label: string, ok: boolean | null, value: string) => (
    <div className="flex items-start gap-3 py-2 border-b border-border last:border-0">
      <span className={`mt-0.5 w-4 h-4 rounded-full flex-shrink-0 ${ok === true ? 'bg-success' : ok === false ? 'bg-danger' : 'bg-text-muted'}`} />
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted">{value}</p>
      </div>
    </div>
  )

  return (
    <Modal
      isOpen={!!result}
      onClose={onClose}
      title={`RPC Health: ${result.chain}`}
      size="md"
      footer={<Button variant="secondary" onClick={onClose} className="w-full">Close</Button>}
    >
      <div className={`-mx-6 -mt-5 px-6 py-3 mb-4 ${result.allClear ? 'bg-success/10' : 'bg-danger/10'}`}>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${result.allClear ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'}`}>
          {result.allClear ? 'All Clear' : 'Issues Found'}
        </span>
      </div>
      <div className="space-y-1">
        {row('RPC Reachable', result.rpc.reachable, result.rpc.reachable ? `Block #${result.rpc.blockNumber?.toLocaleString()} · ${result.rpc.latencyMs}ms` : (result.rpc.error ?? 'Unreachable'))}
        {result.rpc.isStale && row('Stale Node', false, 'Block number has not advanced in 5+ minutes')}
        {row('Signer Available', result.signer.ok, result.signer.ok ? 'Private key or mnemonic is accessible' : (result.signer.error ?? 'No key found'))}
        {row('Address Derivation', result.signer.addressMatch, result.signer.derivedAddress ? `Derived: ${result.signer.derivedAddress.slice(0, 10)}… matches DB` : 'Legacy key — no derivation check')}
        {row('Latest Block Reachable', result.rpc.reachable && result.rpc.blockNumber !== null, result.rpc.blockNumber !== null ? `Block #${result.rpc.blockNumber.toLocaleString()}` : 'N/A')}
      </div>
    </Modal>
  )
}

// ─── WalletCard ───────────────────────────────────────────────────────────────

// Chains that settle USDT refunds on their own network — their native hot-wallet
// balance doubles as the "refund gas" that pays those refund tx fees. (Aptos is
// surfaced separately via its own card.)
const REFUND_GAS_CHAINS = new Set(['TRON', 'BSC', 'ETH'])

function WalletCard({
  wallet, isSuperAdmin, toggling, onToggle, onRefresh, refreshing, onTestRpc, testingRpc,
}: {
  wallet: GasWallet
  isSuperAdmin: boolean
  toggling: boolean
  onToggle: () => void
  onRefresh: () => void
  refreshing: boolean
  onTestRpc: () => void
  testingRpc: boolean
}) {
  const estDeliveries = estimatedDeliveries(wallet)

  return (
    <div className={`bg-surface border rounded-xl p-5 ${
      wallet.status === 'paused' || wallet.status === 'rpc_error' ? 'border-danger/40 bg-red-500/10'
      : wallet.status === 'low' ? 'border-warning/40 bg-yellow-500/10'
      : wallet.status === 'price_unavailable' ? 'border-orange-500/50 bg-orange-500/10'
      : 'border-border'
    }`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${walletHealthDot(wallet.status)}`} />
            <EntityLogo type="chain" slug={wallet.chain} size="sm" />
            <h2 className="text-sm font-semibold text-text-primary">{chainDisplayName(wallet.chain)} Hot Wallet</h2>
            <Badge variant={walletStatusVariant(wallet.status)} size="sm">
              {walletStatusLabel(wallet.status, wallet.pauseReason)}
            </Badge>
            {REFUND_GAS_CHAINS.has(wallet.chain) && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-alt text-text-muted border border-border">
                {wallet.nativeSymbol} Refund Gas
              </span>
            )}
          </div>

          {/* Address — TON shows user-friendly UQ… form */}
          <p className="text-xs font-mono text-text-muted truncate mb-3">{wallet.chain === 'TON' && wallet.friendlyAddress ? wallet.friendlyAddress : wallet.address}</p>

          {/* Metrics */}
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
            <div>
              <span className="text-text-muted">Balance: </span>
              <span className={`font-bold ${
                wallet.balance === null ? 'text-text-muted'
                : wallet.status === 'paused' ? 'text-danger'
                : wallet.status === 'low' ? 'text-warning'
                : 'text-success'
              }`}>
                {wallet.balance !== null
                  ? `${fmtNative(wallet.balance)} ${wallet.nativeSymbol}`
                  : 'Unknown'}
                {wallet.balanceUsd != null && wallet.balanceUsd > 0
                  ? <span className="ml-1 font-normal text-text-muted">(~${wallet.balanceUsd.toFixed(2)})</span>
                  : wallet.balance !== null && wallet.status === 'price_unavailable'
                  ? <span className="ml-1 font-normal text-orange-500 italic">(price unavailable)</span>
                  : null
                }
              </span>
            </div>

            {estDeliveries !== null && (
              <div>
                <span className="text-text-muted">Est. deliveries: </span>
                <span className={`font-medium ${estDeliveries < 20 ? 'text-warning' : 'text-text-primary'}`}>
                  ~{estDeliveries.toLocaleString()}
                </span>
              </div>
            )}

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

            <div>
              <span className="text-text-muted">Refreshed: </span>
              <span className="text-text-secondary">{fmtRelativeTime(wallet.lastBalanceRefreshAt)}</span>
            </div>
          </div>
        </div>

        {/* Actions — row that wraps on mobile (sits below the info), stacked
            column on desktop. Prevents the controls overlapping the title. */}
        <div className="flex flex-row flex-wrap gap-1.5 sm:flex-col sm:shrink-0">
          <Link
            href={`/admin/gas/wallet/${wallet.chain}`}
            className="text-center text-xs font-medium text-primary border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/5 transition-colors"
          >
            View tokens →
          </Link>
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh Balance'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onTestRpc} disabled={testingRpc}>
            {testingRpc ? 'Testing…' : 'Test RPC'}
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

// ─── Analytics Panel ──────────────────────────────────────────────────────────

function AnalyticsPanel({ analytics }: { analytics: GasAnalytics }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5">
      <h2 className="text-sm font-semibold text-text-primary mb-4">
        Delivery Analytics
        <span className="ml-2 text-xs font-normal text-text-muted">({analytics.period})</span>
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="bg-surface rounded-lg p-3">
          <p className="text-xs text-text-muted">Successful</p>
          <p className="text-xl font-bold text-success mt-1">{analytics.successCount.toLocaleString()}</p>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <p className="text-xs text-text-muted">Failed</p>
          <p className={`text-xl font-bold mt-1 ${analytics.failedCount > 0 ? 'text-danger' : 'text-text-primary'}`}>
            {analytics.failedCount.toLocaleString()}
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <p className="text-xs text-text-muted">Avg. Completion</p>
          <p className="text-xl font-bold text-text-primary mt-1">
            {analytics.avgCompletionSec !== null ? fmtSeconds(analytics.avgCompletionSec) : '—'}
          </p>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <p className="text-xs text-text-muted">Overall Rate</p>
          <p className="text-xl font-bold text-text-primary mt-1">
            {analytics.successCount + analytics.failedCount > 0
              ? `${Math.round(analytics.successCount / (analytics.successCount + analytics.failedCount) * 100)}%`
              : '—'}
          </p>
        </div>
      </div>

      {analytics.chainStats.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="text-left pb-2 font-medium">Chain</th>
                <th className="text-right pb-2 font-medium">Delivered</th>
                <th className="text-right pb-2 font-medium">Failed</th>
                <th className="text-right pb-2 font-medium">Success Rate</th>
                <th className="text-right pb-2 font-medium">Rate Bar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {analytics.chainStats.sort((a, b) => b.total - a.total).map((c) => (
                <tr key={c.chain} className="py-1.5">
                  <td className="py-1.5 font-medium text-text-primary">
                    <span className="inline-flex items-center gap-1.5">
                      <EntityLogo type="chain" slug={c.chain} size="xs" />
                      {chainDisplayName(c.chain)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-success">{c.delivered}</td>
                  <td className="py-1.5 text-right text-danger">{c.failed}</td>
                  <td className="py-1.5 text-right font-medium">
                    {c.successRate !== null ? `${c.successRate}%` : '—'}
                  </td>
                  <td className="py-1.5 text-right">
                    {c.successRate !== null && (
                      <div className="w-16 h-1.5 bg-border rounded-full ml-auto">
                        <div
                          className={`h-1.5 rounded-full ${c.successRate >= 90 ? 'bg-success' : c.successRate >= 70 ? 'bg-warning' : 'bg-danger'}`}
                          style={{ width: `${c.successRate}%` }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Financial KPI Dashboard ──────────────────────────────────────────────────

function fmtUsd(n: number) { return `$${n.toFixed(2)}` }
function fmtPkr(n: number) { return `PKR ${Math.round(n).toLocaleString()}` }
function fmtPct(n: number) { return `${n.toFixed(1)}%` }

function FinancialKpiSection({ kpi, loading, onTotalOrders }: { kpi: GasFinancialKpi | null; loading: boolean; onTotalOrders?: () => void }) {
  if (loading) return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-28 bg-surface rounded-xl animate-pulse" />
      ))}
    </div>
  )
  if (!kpi) return null

  const margin      = kpi.marginPct
  const marginColor = margin >= 50 ? 'text-success' : margin >= 20 ? 'text-warning' : 'text-danger'
  const marginBg    = margin >= 50 ? 'bg-success'   : margin >= 20 ? 'bg-warning'   : 'bg-danger'

  const cards: Array<{ label: string; primary: string; secondary: string; accent: string; onClick?: () => void }> = [
    { label: 'Total Orders',         primary: kpi.totalOrders.toLocaleString(), secondary: `Rate ${fmtUsd(kpi.usdPkrRate)}/USD`, accent: 'text-text-primary', onClick: onTotalOrders },
    { label: 'Payment Received',     primary: fmtUsd(kpi.paymentReceivedUsdt),  secondary: fmtPkr(kpi.paymentReceivedPkr),        accent: 'text-text-primary' },
    { label: 'Gas Delivered',        primary: fmtUsd(kpi.gasSpentUsdt),         secondary: fmtPkr(kpi.gasSpentPkr),               accent: 'text-warning' },
    { label: 'Refunds Issued',       primary: fmtUsd(kpi.refundCostUsdt),       secondary: fmtPkr(kpi.refundCostPkr),             accent: kpi.refundCostUsdt > 0 ? 'text-danger' : 'text-text-primary' },
    { label: 'Net Profit',           primary: fmtUsd(kpi.netProfitUsdt),        secondary: fmtPkr(kpi.netProfitPkr),              accent: kpi.netProfitUsdt >= 0 ? 'text-success' : 'text-danger' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map(({ label, primary, secondary, accent, onClick }) => (
        <div
          key={label}
          onClick={onClick}
          role={onClick ? 'button' : undefined}
          tabIndex={onClick ? 0 : undefined}
          onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
          className={`bg-surface shadow-card border border-border rounded-xl p-4 ${onClick ? 'cursor-pointer hover:border-primary/40 hover:shadow-md transition-all' : ''}`}
        >
          <p className="text-xs text-text-muted font-medium uppercase tracking-wide mb-2">{label}{onClick && <span className="text-primary ml-1">→</span>}</p>
          <p className={`text-xl font-bold ${accent}`}>{primary}</p>
          <p className="text-sm text-text-muted mt-0.5">{secondary}</p>
          {label === 'Net Profit' && (
            <>
              <div className="mt-2 h-1.5 bg-border rounded-full overflow-hidden">
                <div className={`h-1.5 rounded-full transition-all ${marginBg}`}
                  style={{ width: `${Math.min(Math.max(margin, 0), 100)}%` }} />
              </div>
              <p className={`text-xs font-bold mt-1 ${marginColor}`}>{fmtPct(margin)} margin</p>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface PollerHealthNetwork {
  network: string
  configured: boolean
  status: 'green' | 'yellow' | 'red'
  ok: boolean | null
  lastTickAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  lastFound: number | null
  currentBlock: number | null
  syncedBlock: number | null
  ageSeconds: number | null
  successAgeSeconds: number | null
  healthy: boolean
}

const STATUS_DOT: Record<PollerHealthNetwork['status'], string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-danger',
}
const STATUS_LABEL: Record<PollerHealthNetwork['status'], string> = {
  green: 'Healthy',
  yellow: 'Delayed',
  red: 'Offline',
}

// At-a-glance health of each gas payment poller (see GET /admin/gas/poller-health).
function PollerHealthCard() {
  const [data, setData] = useState<PollerHealthNetwork[] | null>(null)
  const [err, setErr] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ networks: PollerHealthNetwork[] }>('/admin/gas/poller-health')
      setData(res.networks)
      setErr(false)
    } catch {
      setErr(true)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 60_000)
    return () => clearInterval(id)
  }, [load])

  if (err && !data) return null // stay quiet on transient errors

  return (
    <div className="border border-border rounded-xl p-4 bg-surface">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">Payment Detection Health</h2>
        <div className="flex items-center gap-3">
          <span className="hidden sm:flex items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success" /> Healthy</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warning" /> Delayed</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-danger" /> Offline</span>
          </span>
          <span className="text-xs text-text-muted">auto-refreshes every 60s</span>
        </div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {(data ?? []).map((n) => {
          const lag = n.currentBlock != null && n.syncedBlock != null ? n.currentBlock - n.syncedBlock : null
          return (
            <div key={n.network} className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-text-primary">{n.network}</span>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <span className={`w-2 h-2 rounded-full ${STATUS_DOT[n.status]}`} />
                  <span className="text-text-secondary">{!n.configured ? 'Not configured' : STATUS_LABEL[n.status]}</span>
                </span>
              </div>
              <div className="text-[11px] text-text-muted space-y-0.5">
                <p>Last scan: {n.lastTickAt ? fmtRelativeTime(n.lastTickAt) : 'never'}</p>
                <p>Last success: {n.lastSuccessAt ? fmtRelativeTime(n.lastSuccessAt) : 'never'}{typeof n.lastFound === 'number' ? ` · ${n.lastFound} found` : ''}</p>
                {n.currentBlock != null && (
                  <p>Block: {n.syncedBlock?.toLocaleString() ?? '—'} / {n.currentBlock.toLocaleString()}{lag != null && lag > 0 ? ` (−${lag.toLocaleString()})` : ''}</p>
                )}
                {n.lastError && (
                  <p className="text-danger truncate" title={n.lastError}>⚠ {n.lastError}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ChainHealth {
  chain: string; name: string; nativeSymbol: string; networkLabel: string
  status: 'green' | 'yellow' | 'red'; reachable: boolean; blockNumber: number | null
  latencyMs: number; isStale: boolean; error: string | null; usingFallback?: string | null; deliveryImplemented: boolean
}

// Live RPC health for every supported gas chain (see GET /admin/gas/chain-health).
function ChainHealthCard() {
  const [data, setData] = useState<{ chains: ChainHealth[]; summary: { green: number; yellow: number; red: number } } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { const res = await adminApi.getChainHealth(); setData({ chains: res.chains, summary: res.summary }); setErr(false) }
    catch { setErr(true) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const id = setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 120_000); return () => clearInterval(id) }, [load])

  if (err && !data) return null

  return (
    <div className="border border-border rounded-xl p-4 bg-surface">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Chain RPC Health</h2>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-[11px] text-text-muted flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success" /> {data.summary.green}</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warning" /> {data.summary.yellow}</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-danger" /> {data.summary.red}</span>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={load} loading={loading}>Refresh</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {(data?.chains ?? []).map((c) => (
          <div key={c.chain} className="rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-1">
              <span className="text-sm font-medium text-text-primary">{c.name}</span>
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${c.status === 'green' ? 'bg-success' : c.status === 'yellow' ? 'bg-warning' : 'bg-danger'}`} title={c.status} />
            </div>
            <div className="text-[10px] text-text-muted mt-0.5 space-y-0.5">
              <p>{c.networkLabel} · {c.nativeSymbol}</p>
              {c.reachable ? (
                <>
                  <p>block {c.blockNumber?.toLocaleString() ?? '—'} · {c.latencyMs}ms{c.isStale ? ' · stale' : ''}</p>
                  {c.usingFallback && <p className="text-warning truncate" title={c.usingFallback}>primary down · using {c.usingFallback}</p>}
                </>
              ) : (
                <p className="text-danger truncate" title={c.error ?? undefined}>unreachable{c.error ? `: ${c.error}` : ''}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function GasAdminPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading gas orders..." />}>
      <GasAdminPageInner />
    </Suspense>
  )
}

function GasAdminPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  // Stats state
  const [stats, setStats] = useState<GasStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  // Analytics state
  const [analytics, setAnalytics] = useState<GasAnalytics | null>(null)
  const [analyticsPeriod, setAnalyticsPeriod] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
  const [showAnalytics, setShowAnalytics] = useState(false)

  // Financial KPI state
  const [kpiTab, setKpiTab] = useState<'today' | 'alltime' | 'custom'>('today')
  const [kpiFrom, setKpiFrom] = useState('')
  const [kpiTo, setKpiTo]     = useState('')
  const [customKpi, setCustomKpi] = useState<GasFinancialKpi | null>(null)
  const [customKpiLoading, setCustomKpiLoading] = useState(false)

  // Global pause state
  const [globalPaused, setGlobalPaused] = useState(false)
  const [globalPauseReason, setGlobalPauseReason] = useState<string | null>(null)
  const [confirmGlobalPause, setConfirmGlobalPause] = useState<boolean | null>(null) // true=pause, false=resume
  const [globalPauseReasonInput, setGlobalPauseReasonInput] = useState('')
  const [togglingGlobalPause, setTogglingGlobalPause] = useState(false)

  // RPC test state
  const [rpcTestResult, setRpcTestResult] = useState<RpcTestResult | null>(null)
  const [testingRpc, setTestingRpc] = useState<string | null>(null)

  // Action state
  const [confirmToggle, setConfirmToggle] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<string | null>(null)

  // Legacy deep links (/admin/gas?status=…&paymentType=…) now live on Payment Orders.
  useEffect(() => {
    const f = parseGasOrderFilters(searchParams)
    if (f.status !== 'all' || f.paymentType !== 'all') router.replace(paymentOrdersHref(f))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const data = await adminApi.getGasStats()
      setStats(data)
      setStatsError(null)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load stats')
    }
  }, [])

  const fetchGlobalPause = useCallback(async () => {
    try {
      const data = await adminApi.getGasGlobalPause()
      setGlobalPaused(data.paused)
      setGlobalPauseReason(data.reason)
    } catch { /* non-critical */ }
  }, [])

  const fetchAnalytics = useCallback(async () => {
    try {
      const data = await adminApi.getGasAnalytics(analyticsPeriod)
      setAnalytics(data)
    } catch { /* non-critical */ }
  }, [analyticsPeriod])

  const fetchCustomKpi = useCallback(async () => {
    if (!kpiFrom && !kpiTo) return
    setCustomKpiLoading(true)
    try {
      const data = await adminApi.getGasFinancials(kpiFrom || undefined, kpiTo || undefined)
      setCustomKpi(data)
    } catch { /* non-critical */ }
    finally { setCustomKpiLoading(false) }
  }, [kpiFrom, kpiTo])

  const refresh = useCallback(async () => {
    await Promise.all([fetchStats(), fetchGlobalPause()])
  }, [fetchStats, fetchGlobalPause])

  usePolling(refresh, 30_000)

  // Fetch analytics on demand
  const handleShowAnalytics = useCallback(async () => {
    setShowAnalytics(true)
    await fetchAnalytics()
  }, [fetchAnalytics])

  // Re-fetch analytics when period changes
  const handleAnalyticsPeriod = useCallback(async (p: '24h' | '7d' | '30d' | 'all') => {
    setAnalyticsPeriod(p)
    try {
      const data = await adminApi.getGasAnalytics(p)
      setAnalytics(data)
    } catch { /* non-critical */ }
  }, [])

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
      setActionSuccess(`${chain} balance refreshed: ${res.balance.toFixed(6)} ${res.nativeSymbol}${res.balanceUsd !== null ? ` (~$${res.balanceUsd.toFixed(2)})` : ''}`)
      void fetchStats()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to refresh ${chain} balance`)
    } finally {
      setRefreshing(null)
    }
  }

  async function handleTestRpc(chain: string) {
    setTestingRpc(chain)
    setActionError(null)
    try {
      const res = await adminApi.testRpcHealth(chain)
      setRpcTestResult(res)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to test ${chain} RPC`)
    } finally {
      setTestingRpc(null)
    }
  }

  async function handleGlobalPauseToggle() {
    if (confirmGlobalPause === null) return
    setTogglingGlobalPause(true)
    setActionError(null)
    try {
      const reason = confirmGlobalPause ? globalPauseReasonInput || undefined : undefined
      await adminApi.setGasGlobalPause(confirmGlobalPause, reason)
      setGlobalPaused(confirmGlobalPause)
      setGlobalPauseReason(confirmGlobalPause ? (reason ?? null) : null)
      setConfirmGlobalPause(null)
      setGlobalPauseReasonInput('')
      setActionSuccess(confirmGlobalPause ? 'Gas delivery globally paused.' : 'Global pause lifted — delivery resumed.')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to change global pause state')
    } finally {
      setTogglingGlobalPause(false)
    }
  }

  if (!stats && !statsError) return <LoadingState message="Loading gas operations..." />

  return (
    <div className="space-y-5">
      {/* ── Global Pause Banner ──────────────────────────────────────────────── */}
      {globalPaused && (
        <div className="flex items-center gap-3 px-5 py-4 bg-red-600 text-white rounded-xl shadow-md">
          <svg className="w-6 h-6 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="flex-1">
            <p className="font-bold">GLOBAL GAS PAUSE ACTIVE — All deliveries are halted.</p>
            {globalPauseReason && <p className="text-sm opacity-90 mt-0.5">Reason: {globalPauseReason}</p>}
          </div>
          {isSuperAdmin && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmGlobalPause(false)}
              className="bg-white text-red-700 hover:bg-red-50 border-white font-semibold flex-shrink-0"
            >
              Resume Delivery
            </Button>
          )}
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Gas Fee Operations</h1>
          <p className="text-text-muted text-sm mt-0.5">Hot wallets, chain health and financial KPIs</p>
        </div>
        {/* Mobile: an even 2-column grid so every action is visible and aligned
            (was a hidden horizontal-scroll strip that clipped the later buttons).
            lg+: a normal inline row. */}
        <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-center lg:justify-end">
          {isSuperAdmin && !globalPaused && (
            <Button size="sm" variant="danger" fullWidth className="lg:w-auto" onClick={() => setConfirmGlobalPause(true)}>
              Emergency Pause
            </Button>
          )}
          <Button size="sm" variant="ghost" fullWidth className="lg:w-auto" onClick={showAnalytics ? () => setShowAnalytics(false) : handleShowAnalytics}>
            {showAnalytics ? 'Hide Analytics' : 'Analytics'}
          </Button>
          <Link href="/admin/gas/requests" className="w-full lg:w-auto">
            <Button size="sm" variant="ghost" fullWidth className="lg:w-auto">Custom Requests</Button>
          </Link>
          <Link href="/admin/gas/diagnostics" className="w-full lg:w-auto">
            <Button size="sm" variant="ghost" fullWidth className="lg:w-auto">Token Diagnostics</Button>
          </Link>
          <Link href="/admin/gas/chains" className="w-full lg:w-auto">
            <Button size="sm" variant="secondary" fullWidth className="lg:w-auto">Chain &amp; Token Config</Button>
          </Link>
        </div>
      </div>

      {/* ── Payment Detection Health ─────────────────────────────────────────── */}
      <PollerHealthCard />

      {/* ── Chain RPC Health (all supported chains) ──────────────────────────── */}
      <ChainHealthCard />

      {/* ── Alerts ───────────────────────────────────────────────────────────── */}
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

      {/* ── Operational Quick Stats (clickable → filtered orders / requests) ──── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Link
            href={paymentOrdersHref({ status: 'active' })}
            className="text-left bg-surface shadow-card border border-border rounded-xl p-4 cursor-pointer hover:border-primary/40 hover:shadow-md transition-all"
          >
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Active Orders <span className="text-primary ml-1">→</span></p>
            <p className="text-2xl font-bold text-warning mt-1">{stats.pendingCount}</p>
          </Link>
          <Link
            href={paymentOrdersHref({ status: 'failed' })}
            className="text-left bg-surface shadow-card border border-border rounded-xl p-4 cursor-pointer hover:border-primary/40 hover:shadow-md transition-all"
          >
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Failed Orders <span className="text-primary ml-1">→</span></p>
            <p className={`text-2xl font-bold mt-1 ${stats.failedCount > 0 ? 'text-danger' : 'text-text-primary'}`}>{stats.failedCount}</p>
          </Link>
          <Link
            href={paymentOrdersHref({ status: 'refund_pending' })}
            className={`text-left bg-surface shadow-card rounded-xl p-4 cursor-pointer hover:shadow-md transition-all ${(stats.refundPendingCount ?? 0) > 0 ? 'border border-warning/40 hover:border-warning' : 'border border-border hover:border-primary/40'}`}
          >
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Refund Pending <span className="text-primary ml-1">→</span></p>
            <p className={`text-2xl font-bold mt-1 ${(stats.refundPendingCount ?? 0) > 0 ? 'text-warning' : 'text-text-primary'}`}>{stats.refundPendingCount ?? 0}</p>
          </Link>
          <Link
            href="/admin/gas/requests"
            className="block bg-surface shadow-card border border-border rounded-xl p-4 cursor-pointer hover:border-primary/40 hover:shadow-md transition-all"
          >
            <p className="text-xs text-text-muted font-medium uppercase tracking-wide">Custom Requests <span className="text-primary ml-1">→</span></p>
            <p className={`text-2xl font-bold mt-1 ${(stats.pendingCustomRequests ?? 0) > 0 ? 'text-warning' : 'text-text-primary'}`}>{stats.pendingCustomRequests ?? 0}</p>
          </Link>
        </div>
      )}

      {/* ── Financial KPI Dashboard ──────────────────────────────────────────── */}
      <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center gap-0 border-b border-border">
          {(['today', 'alltime', 'custom'] as const).map((tab) => (
            <button key={tab} onClick={() => setKpiTab(tab)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                kpiTab === tab ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {tab === 'today' ? 'Today' : tab === 'alltime' ? 'All Time' : 'Date Range'}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-4">
          {/* Custom date range picker */}
          {kpiTab === 'custom' && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted font-medium">From</label>
                <input type="date" value={kpiFrom} onChange={e => setKpiFrom(e.target.value)}
                  className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted font-medium">To</label>
                <input type="date" value={kpiTo} onChange={e => setKpiTo(e.target.value)}
                  className="border border-border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              </div>
              <button onClick={fetchCustomKpi} disabled={customKpiLoading || (!kpiFrom && !kpiTo)}
                className="px-3 py-1.5 bg-primary text-white text-sm rounded-lg font-medium disabled:opacity-50 hover:opacity-90 transition-opacity">
                {customKpiLoading ? 'Loading…' : 'Apply'}
              </button>
              {customKpi && (
                <button onClick={() => { setCustomKpi(null); setKpiFrom(''); setKpiTo('') }}
                  className="text-xs text-text-muted hover:text-danger underline">Clear</button>
              )}
            </div>
          )}

          {/* KPI cards */}
          {kpiTab === 'today' && (
            <FinancialKpiSection kpi={stats?.today ?? null} loading={!stats} onTotalOrders={() => router.push(paymentOrdersHref())} />
          )}
          {kpiTab === 'alltime' && (
            <FinancialKpiSection kpi={stats?.allTime ?? null} loading={!stats} onTotalOrders={() => router.push(paymentOrdersHref())} />
          )}
          {kpiTab === 'custom' && (
            <FinancialKpiSection kpi={customKpi} loading={customKpiLoading} />
          )}
          {kpiTab === 'custom' && !customKpi && !customKpiLoading && (
            <p className="text-sm text-text-muted text-center py-4">Select a date range and click Apply</p>
          )}
        </div>
      </div>

      {/* ── Analytics Panel ──────────────────────────────────────────────────── */}
      {showAnalytics && (
        <div>
          <div className="flex gap-2 mb-3">
            {(['24h', '7d', '30d', 'all'] as const).map((p) => (
              <button
                key={p}
                onClick={() => handleAnalyticsPeriod(p)}
                className={`px-3 py-1 text-xs rounded-lg border font-medium transition-colors ${
                  analyticsPeriod === p ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface'
                }`}
              >
                {p === 'all' ? 'All Time' : p}
              </button>
            ))}
          </div>
          {analytics ? <AnalyticsPanel analytics={analytics} /> : (
            <div className="bg-surface shadow-card border border-border rounded-xl p-8 text-center text-text-muted text-sm">Loading analytics…</div>
          )}
        </div>
      )}

      {/* ── Payment Orders shortcut ─────────────────────────────────────────── */}
      <Link
        href={paymentOrdersHref()}
        className="flex items-center gap-3 px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-text-primary hover:bg-primary/10 transition-colors"
      >
        <Fuel className="w-5 h-5 text-primary flex-shrink-0" aria-hidden />
        <span><strong>Payment orders moved.</strong> Proof review, approvals, refunds and the full order list now live on their own page.</span>
        <span className="ml-auto text-xs font-bold text-primary whitespace-nowrap">Open Payment Orders →</span>
      </Link>

      {/* ── Custom Gas Requests Alert ────────────────────────────────────────── */}
      {(stats?.pendingCustomRequests ?? 0) > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-500/10 border border-blue-500/30 rounded-xl text-sm text-blue-800 dark:text-blue-300">
          <svg className="w-5 h-5 flex-shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
          <span><strong>{stats!.pendingCustomRequests} custom gas request{stats!.pendingCustomRequests > 1 ? 's' : ''} pending review.</strong> Users have submitted unsupported chain requests.</span>
          <Link href="/admin/gas/requests" className="ml-auto text-xs font-bold border border-blue-500/50 rounded-lg px-2.5 py-1 hover:bg-blue-500/15">
            Review →
          </Link>
        </div>
      )}

      {/* ── Critical Wallet Alert ────────────────────────────────────────────── */}
      {stats?.wallets?.some(w => w.status === 'paused') && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-800 dark:text-red-300">
          <svg className="w-5 h-5 flex-shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span>
            <strong>Hot wallet paused:</strong>{' '}
            {stats.wallets
              .filter(w => w.status === 'paused')
              .map(w => `${chainDisplayName(w.chain)} (${w.pauseReason === 'manual' ? 'manually' : 'low balance'})`)
              .join(', ')}.
            {' '}New orders are paused on these chains.
          </span>
        </div>
      )}

      {/* ── Price Unavailable Warning ────────────────────────────────────────── */}
      {stats?.wallets?.some(w => w.status === 'price_unavailable') && (
        <div className="flex items-center gap-3 px-4 py-3 bg-orange-500/10 border border-orange-500/30 rounded-xl text-sm text-orange-800 dark:text-orange-300">
          <svg className="w-5 h-5 flex-shrink-0 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span>
            <strong>Price unavailable:</strong>{' '}
            {stats.wallets.filter(w => w.status === 'price_unavailable').map(w => `${chainDisplayName(w.chain)} (${w.nativeSymbol})`).join(', ')}.
            {' '}Live balance is fetched successfully, but USD value cannot be calculated yet. Price feed will sync automatically.
          </span>
        </div>
      )}

      {/* ── RPC Error Warning ────────────────────────────────────────────────── */}
      {stats?.wallets?.some(w => w.status === 'rpc_error') && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-800 dark:text-red-300">
          <svg className="w-5 h-5 flex-shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <span>
            <strong>RPC error:</strong>{' '}
            {stats.wallets.filter(w => w.status === 'rpc_error').map(w => w.chain).join(', ')}.
            {' '}Balance fetch failed — use &ldquo;Test RPC&rdquo; to diagnose.
          </span>
        </div>
      )}

      {/* ── Aptos Hot Wallet Card ────────────────────────────────────────────── */}
      {stats?.aptosGas && (
        <div className={`bg-surface border rounded-xl p-5 ${stats.aptosGas.lowApt ? 'border-warning/40 bg-yellow-500/10' : 'border-border'}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${stats.aptosGas.lowApt ? 'bg-yellow-400' : 'bg-green-500'}`} />
                <EntityLogo type="chain" slug="APT" size="sm" />
                <h2 className="text-sm font-semibold text-text-primary">Aptos Hot Wallet</h2>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${stats.aptosGas.lowApt ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'}`}>
                  {stats.aptosGas.lowApt ? 'Low Balance' : 'Healthy'}
                </span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-alt text-text-muted border border-border">APT Refund Gas</span>
              </div>
              <p className="text-xs font-mono text-text-muted truncate mb-3">{stats.aptosGas.address}</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                <div>
                  <span className="text-text-muted">Balance: </span>
                  <span className={`font-bold ${stats.aptosGas.lowApt ? 'text-warning' : 'text-success'}`}>
                    {stats.aptosGas.balance !== null ? `${stats.aptosGas.balance.toFixed(4)} APT` : 'Unknown'}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted">Min APT: </span>
                  <span className="font-medium text-text-primary">{stats.aptosGas.minApt} APT</span>
                </div>
              </div>
              {stats.aptosGas.lowApt && (
                <p className="text-xs mt-2 text-warning font-medium">
                  Low on APT gas — USDT refunds on Aptos require APT to pay transaction fees. Top up this wallet to prevent refund failures.
                </p>
              )}
            </div>
            <Link
              href="/admin/gas/wallet/APT"
              className="shrink-0 text-center text-xs font-medium text-primary border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/5 transition-colors"
            >
              View tokens →
            </Link>
          </div>
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
              onTestRpc={() => handleTestRpc(w.chain)}
              testingRpc={testingRpc === w.chain}
            />
          ))}
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
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

      {/* Global pause confirm modal */}
      <Modal
        isOpen={confirmGlobalPause !== null}
        onClose={() => { setConfirmGlobalPause(null); setGlobalPauseReasonInput('') }}
        title={confirmGlobalPause ? 'Emergency Global Pause' : 'Resume Gas Delivery'}
        size="sm"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { setConfirmGlobalPause(null); setGlobalPauseReasonInput('') }} className="flex-1">
              Cancel
            </Button>
            <Button
              variant={confirmGlobalPause ? 'danger' : 'primary'}
              onClick={handleGlobalPauseToggle}
              disabled={togglingGlobalPause}
              className="flex-1"
            >
              {togglingGlobalPause ? 'Saving…' : confirmGlobalPause ? 'Pause All' : 'Resume All'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {confirmGlobalPause
              ? 'This will immediately halt ALL gas deliveries across all chains. Queued jobs will retry when the pause is lifted.'
              : 'Gas delivery will resume across all chains. Queued orders will begin processing immediately.'}
          </p>
          {confirmGlobalPause && (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Reason (optional)</label>
              <input
                type="text"
                value={globalPauseReasonInput}
                onChange={(e) => setGlobalPauseReasonInput(e.target.value)}
                placeholder="e.g. Hot wallet drained — investigating"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-danger/40"
              />
            </div>
          )}
        </div>
      </Modal>

      {/* RPC test result modal */}
      {rpcTestResult && <RpcTestModal result={rpcTestResult} onClose={() => setRpcTestResult(null)} />}
    </div>
  )
}
