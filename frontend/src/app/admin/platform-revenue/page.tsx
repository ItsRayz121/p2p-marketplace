'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SweepableRow {
  token: string
  chain: string
  collected: number
  swept: number
  available: number
  count: number
  canSweep: boolean
}

interface RevenueSummary {
  allTime:   { totalTokenFees: number; totalUsdFees: number; totalSwept: number; available: number; count: number }
  today:     { totalTokenFees: number; totalUsdFees: number; count: number }
  thisWeek:  { totalTokenFees: number; totalUsdFees: number }
  thisMonth: { totalTokenFees: number; totalUsdFees: number }
  sweepable: SweepableRow[]
  byToken: Array<{ token: string; amount: number; usdAmount: number; count: number }>
  byChain: Array<{ chain: string; amount: number; usdAmount: number; count: number }>
  dailyChart: Array<{ date: string; tokenAmount: number; usdAmount: number; count: number }>
  treasuryAddresses: { evm: string | null; tron: string | null }
}

interface FeeEntry {
  id: string
  chain: string
  tokenSymbol: string | null
  tokenAmount: string | null
  usdAmount: string
  txHash: string | null
  sourceKey: string | null
  notes: string | null
  createdAt: string
}

interface SweepEntry {
  id: string
  chain: string
  tokenSymbol: string | null
  tokenAmount: string | null
  usdAmount: string
  txHash: string | null
  fromAddress: string | null
  toAddress: string | null
  notes: string | null
  createdAt: string
}

interface SweepResult {
  txHash: string
  treasuryAddress: string
  hotWalletAddress: string
  tokenSymbol: string
  chain: string
  amount: number
  hotWalletBalanceBefore: number
  remainingAvailable: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHAIN_EXPLORER_TX: Record<string, string> = {
  BSC:  'https://bscscan.com/tx/',
  ETH:  'https://etherscan.io/tx/',
  BASE: 'https://basescan.org/tx/',
  ARB:  'https://arbiscan.io/tx/',
  OP:   'https://optimistic.etherscan.io/tx/',
  MATIC:'https://polygonscan.com/tx/',
  TRON: 'https://tronscan.org/#/transaction/',
}

const CHAIN_LABEL: Record<string, string> = {
  BSC: 'BNB Chain (BEP20)', ETH: 'Ethereum (ERC20)', BASE: 'Base',
  ARB: 'Arbitrum', OP: 'Optimism', MATIC: 'Polygon', TRON: 'TRON (TRC20)',
}

function txUrl(chain: string, hash: string | null): string | null {
  if (!hash) return null
  return (CHAIN_EXPLORER_TX[chain.toUpperCase()] ?? null)
    ? CHAIN_EXPLORER_TX[chain.toUpperCase()]! + hash
    : null
}

function fmtAmount(n: string | number | null): string {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  return isNaN(v) ? '—' : v.toFixed(6).replace(/\.?0+$/, '') || '0'
}

function fmtUsd(n: string | number | null): string {
  if (n === null || n === undefined) return '—'
  const v = Number(n)
  return isNaN(v) ? '—' : `$${v.toFixed(2)}`
}

function extractWithdrawalId(key: string | null): string | null {
  if (!key) return null
  const p = key.split(':')
  return p.length >= 3 ? (p[2] ?? null) : null
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, primary, sub, badge }: {
  label: string; primary: string; sub?: string; badge?: { text: string; color: string }
}) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <p className="text-xs text-text-muted uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-text-primary">{primary}</p>
      {badge && (
        <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium ${badge.color}`}>
          {badge.text}
        </span>
      )}
      {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
    </div>
  )
}

function DailyChart({ data }: { data: Array<{ date: string; tokenAmount: number; count: number }> }) {
  if (data.length === 0) return <p className="text-sm text-text-muted py-4">No data yet.</p>
  const max = Math.max(...data.map(d => d.tokenAmount), 0.000001)
  return (
    <div className="flex items-end gap-0.5 h-20 w-full">
      {data.map(d => (
        <div
          key={d.date}
          className="flex-1 bg-emerald-600 rounded-sm opacity-80 hover:opacity-100 transition-opacity cursor-default"
          style={{ height: `${Math.max((d.tokenAmount / max) * 100, 2)}%` }}
          title={`${d.date}\n${fmtAmount(d.tokenAmount)} USDT (${d.count} fee${d.count !== 1 ? 's' : ''})`}
        />
      ))}
    </div>
  )
}

// ─── Sweep Confirm Modal ──────────────────────────────────────────────────────

interface SweepModalProps {
  row: SweepableRow
  treasuryAddress: string | null
  onConfirm: (amount: number) => void
  onClose: () => void
  sweeping: boolean
}

function SweepModal({ row, treasuryAddress, onConfirm, onClose, sweeping }: SweepModalProps) {
  const [customAmount, setCustomAmount] = useState<string>('')
  const [mode, setMode] = useState<'all' | 'custom'>('all')

  const amount = mode === 'all' ? row.available : (parseFloat(customAmount) || 0)
  const valid  = amount > 0 && amount <= row.available

  return (
    <Modal isOpen onClose={onClose} title="Sweep Platform Fees to Treasury">
      <div className="space-y-4 text-sm">
        {/* Warning */}
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-amber-700 text-xs space-y-1">
          <p className="font-semibold">Safety notice</p>
          <p>This will send funds <strong>on-chain</strong> from the hot wallet to the treasury wallet. The transaction cannot be reversed.</p>
          <p>Only <strong>platform-owned fees</strong> are being swept — the system prevents you from sweeping more than the ledger-tracked available balance.</p>
        </div>

        {/* Details */}
        <div className="bg-surface border border-border rounded p-3 space-y-2 text-xs font-mono">
          <div className="flex justify-between">
            <span className="text-text-muted">Token</span>
            <span className="text-emerald-600">{row.token}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted">Network</span>
            <span className="text-primary">{CHAIN_LABEL[row.chain] ?? row.chain}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted">Available to sweep</span>
            <span className="text-text-primary">{fmtAmount(row.available)} {row.token}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-muted">Destination (treasury)</span>
            <span className="text-text-secondary break-all">{treasuryAddress ?? '—'}</span>
          </div>
        </div>

        {/* Amount selection */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} className="accent-emerald-600" />
            <span>Sweep all available — <strong>{fmtAmount(row.available)} {row.token}</strong></span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} className="accent-emerald-600" />
            <span>Custom amount</span>
          </label>
          {mode === 'custom' && (
            <div className="ml-6 flex items-center gap-2">
              <input
                type="number"
                min="0"
                max={row.available}
                step="0.000001"
                value={customAmount}
                onChange={e => setCustomAmount(e.target.value)}
                placeholder="0.000000"
                className="bg-white border border-border rounded px-2 py-1 text-text-primary w-36 text-sm"
              />
              <span className="text-text-muted text-xs">{row.token} (max {fmtAmount(row.available)})</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 pt-2">
          <Button
            variant="primary"
            onClick={() => valid && onConfirm(amount)}
            disabled={!valid || sweeping}
            className="flex-1"
          >
            {sweeping ? 'Sending on-chain…' : `Confirm Sweep ${fmtAmount(amount)} ${row.token}`}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={sweeping}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlatformRevenuePage() {
  const [summary, setSummary]             = useState<RevenueSummary | null>(null)
  const [summaryError, setSummaryError]   = useState<string | null>(null)

  const [feeEntries, setFeeEntries]       = useState<FeeEntry[]>([])
  const [feePagination, setFeePagination] = useState({ total: 0, pages: 1, page: 1 })
  const [feePage, setFeePage]             = useState(1)
  const [feeToken, setFeeToken]           = useState('')
  const [feeChain, setFeeChain]           = useState('')
  const [feeFrom, setFeeFrom]             = useState('')
  const [feeTo, setFeeTo]                 = useState('')
  const [feeSearch, setFeeSearch]         = useState('')

  const [sweepHistory, setSweepHistory]   = useState<SweepEntry[]>([])
  const [sweepPagination, setSweepPagination] = useState({ total: 0, pages: 1, page: 1 })
  const [sweepPage, setSweepPage]         = useState(1)

  const [sweepModal, setSweepModal]       = useState<SweepableRow | null>(null)
  const [sweeping, setSweeping]           = useState(false)
  const [sweepResult, setSweepResult]     = useState<SweepResult | null>(null)
  const [sweepError, setSweepError]       = useState<string | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await adminApi.getPlatformRevenueSummary()
      setSummary(res)
      setSummaryError(null)
    } catch (e) { setSummaryError(e instanceof Error ? e.message : 'Failed to load') }
  }, [])

  const fetchFees = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page: feePage, limit: 20 }
      if (feeToken)  params.token  = feeToken
      if (feeChain)  params.chain  = feeChain
      if (feeFrom)   params.from   = feeFrom
      if (feeTo)     params.to     = feeTo
      if (feeSearch) params.search = feeSearch
      const res = await adminApi.getPlatformFeeHistory(params)
      setFeeEntries(res.entries)
      setFeePagination(res.pagination)
    } catch { /* silent */ }
  }, [feePage, feeToken, feeChain, feeFrom, feeTo, feeSearch])

  const fetchSweepHistory = useCallback(async () => {
    try {
      const res = await adminApi.getPlatformSweepHistory({ page: sweepPage, limit: 10 })
      setSweepHistory(res.entries)
      setSweepPagination(res.pagination)
    } catch { /* silent */ }
  }, [sweepPage])

  usePolling(fetchSummary,      30_000, true)
  usePolling(fetchFees,         30_000, true)
  usePolling(fetchSweepHistory, 30_000, true)

  async function doSweep(row: SweepableRow, amount: number) {
    setSweeping(true)
    setSweepError(null)
    setSweepResult(null)
    try {
      const res = await adminApi.sweepPlatformFees({ tokenSymbol: row.token, chain: row.chain, amount })
      setSweepResult(res)
      setSweepModal(null)
      // Refresh everything
      void fetchSummary()
      void fetchSweepHistory()
    } catch (e) {
      setSweepError(e instanceof Error ? e.message : 'Sweep failed')
      setSweepModal(null)
    } finally {
      setSweeping(false)
    }
  }

  if (!summary && !summaryError) return <LoadingState />
  if (summaryError && !summary)  return <ErrorState title={summaryError} onRetry={fetchSummary} />

  const s = summary!

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Revenue</h1>
        <p className="text-sm text-text-muted mt-1">
          Withdrawal fees collected by the platform. Sweep accumulated fees to the treasury wallet when ready.
        </p>
      </div>

      {/* Sweep result banner */}
      {sweepResult && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm">
          <p className="font-semibold text-emerald-700 mb-2">Sweep successful!</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs font-mono text-text-secondary">
            <span className="text-text-muted">Amount swept</span>
            <span>{fmtAmount(sweepResult.amount)} {sweepResult.tokenSymbol} on {CHAIN_LABEL[sweepResult.chain] ?? sweepResult.chain}</span>
            <span className="text-text-muted">Destination</span>
            <span className="break-all">{sweepResult.treasuryAddress}</span>
            <span className="text-text-muted">TX Hash</span>
            <span>
              {txUrl(sweepResult.chain, sweepResult.txHash) ? (
                <a href={txUrl(sweepResult.chain, sweepResult.txHash)!} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {sweepResult.txHash.slice(0, 20)}…
                </a>
              ) : sweepResult.txHash}
            </span>
            <span className="text-text-muted">Remaining available</span>
            <span>{fmtAmount(sweepResult.remainingAvailable)} {sweepResult.tokenSymbol}</span>
          </div>
          <button onClick={() => setSweepResult(null)} className="mt-3 text-xs text-text-muted hover:text-text-primary">Dismiss</button>
        </div>
      )}

      {/* Sweep error banner */}
      {sweepError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <p className="font-semibold mb-1">Sweep failed</p>
          <p className="text-xs">{sweepError}</p>
          <button onClick={() => setSweepError(null)} className="mt-2 text-xs text-text-muted hover:text-text-primary">Dismiss</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Collected (All Time)"
          primary={`${fmtAmount(s.allTime.totalTokenFees)} USDT`}
          sub={`${fmtUsd(s.allTime.totalUsdFees)} · ${s.allTime.count} fee${s.allTime.count !== 1 ? 's' : ''}`}
        />
        <StatCard
          label="Available to Sweep"
          primary={`${fmtAmount(s.allTime.available)} USDT`}
          sub={`${fmtAmount(s.allTime.totalSwept)} already swept`}
          badge={s.allTime.available > 0 ? { text: 'Ready', color: 'bg-emerald-100 text-emerald-700' } : { text: 'None', color: 'bg-gray-100 text-gray-500' }}
        />
        <StatCard label="Today" primary={`${fmtAmount(s.today.totalTokenFees)} USDT`} sub={`${fmtUsd(s.today.totalUsdFees)} · ${s.today.count} fee${s.today.count !== 1 ? 's' : ''}`} />
        <StatCard label="This Month" primary={`${fmtAmount(s.thisMonth.totalTokenFees)} USDT`} sub={fmtUsd(s.thisMonth.totalUsdFees)} />
      </div>

      {/* Treasury wallet addresses */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4 text-xs font-mono">
        <p className="text-text-muted text-xs uppercase tracking-wide mb-2 font-sans font-semibold">Treasury Wallet Addresses</p>
        <div className="space-y-1">
          <div className="flex gap-4"><span className="text-text-muted w-24">EVM</span><span className="text-text-primary break-all">{s.treasuryAddresses.evm ?? 'Not configured'}</span></div>
          <div className="flex gap-4"><span className="text-text-muted w-24">TRON</span><span className="text-text-primary break-all">{s.treasuryAddresses.tron ?? 'Not configured'}</span></div>
        </div>
        <p className="text-text-muted text-xs mt-2 font-sans">Sweep destinations are the platform hot wallet (HD index 0).</p>
      </div>

      {/* Sweepable breakdown */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Available to Sweep — by Token &amp; Network</h2>
        {s.sweepable.length === 0 ? (
          <p className="text-sm text-text-muted">No platform fees collected yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-text-muted border-b border-border">
                  <th className="text-left py-2">Token</th>
                  <th className="text-left py-2">Network</th>
                  <th className="text-right py-2">Collected</th>
                  <th className="text-right py-2">Swept</th>
                  <th className="text-right py-2 text-emerald-600">Available</th>
                  <th className="text-right py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {s.sweepable.map(row => (
                  <tr key={`${row.token}:${row.chain}`} className="border-b border-border hover:bg-surface">
                    <td className="py-2 font-mono text-emerald-600">{row.token}</td>
                    <td className="py-2 text-primary">{CHAIN_LABEL[row.chain] ?? row.chain}</td>
                    <td className="py-2 text-right text-text-secondary font-mono">{fmtAmount(row.collected)}</td>
                    <td className="py-2 text-right text-text-muted font-mono">{fmtAmount(row.swept)}</td>
                    <td className="py-2 text-right font-mono font-semibold text-text-primary">{fmtAmount(row.available)}</td>
                    <td className="py-2 text-right">
                      {row.canSweep ? (
                        <button
                          onClick={() => setSweepModal(row)}
                          className="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition-colors"
                        >
                          Sweep →
                        </button>
                      ) : row.available <= 0 ? (
                        <span className="text-xs text-text-muted">None</span>
                      ) : (
                        <span className="text-xs text-amber-600">Manual (TRC20)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sweep history */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Sweep History</h2>
        {sweepHistory.length === 0 ? (
          <p className="text-sm text-text-muted">No sweeps yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border">
                    <th className="text-left py-2">Date</th>
                    <th className="text-left py-2">Network</th>
                    <th className="text-right py-2">Amount</th>
                    <th className="text-left py-2 pl-4">TX Hash</th>
                    <th className="text-left py-2 pl-4">To (Treasury)</th>
                  </tr>
                </thead>
                <tbody>
                  {sweepHistory.map(e => {
                    const url = txUrl(e.chain, e.txHash)
                    return (
                      <tr key={e.id} className="border-b border-border hover:bg-surface">
                        <td className="py-2 text-text-muted whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                        <td className="py-2 text-primary">{CHAIN_LABEL[e.chain] ?? e.chain}</td>
                        <td className="py-2 text-right font-mono text-emerald-600">
                          {fmtAmount(e.tokenAmount)} {e.tokenSymbol}
                        </td>
                        <td className="py-2 pl-4">
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">
                              {e.txHash?.slice(0, 12)}…
                            </a>
                          ) : <span className="text-text-muted font-mono">{e.txHash?.slice(0, 12)}…</span>}
                        </td>
                        <td className="py-2 pl-4 font-mono text-text-muted max-w-xs truncate">{e.toAddress ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {sweepPagination.pages > 1 && (
              <div className="flex items-center justify-between mt-3 text-xs text-text-muted">
                <span>{sweepPagination.total} total</span>
                <div className="flex gap-2">
                  <button disabled={sweepPage <= 1} onClick={() => setSweepPage(p => p - 1)} className="px-2 py-1 border border-border rounded disabled:opacity-30">Prev</button>
                  <span>{sweepPage}/{sweepPagination.pages}</span>
                  <button disabled={sweepPage >= sweepPagination.pages} onClick={() => setSweepPage(p => p + 1)} className="px-2 py-1 border border-border rounded disabled:opacity-30">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Breakdown tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <h2 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wide">Fees by Token</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-text-muted border-b border-border"><th className="text-left py-1.5">Token</th><th className="text-right py-1.5">Collected</th><th className="text-right py-1.5">USD</th><th className="text-right py-1.5">Count</th></tr></thead>
            <tbody>
              {s.byToken.map(r => (
                <tr key={r.token} className="border-b border-border hover:bg-surface">
                  <td className="py-2 font-mono text-emerald-600">{r.token}</td>
                  <td className="py-2 text-right text-text-primary">{fmtAmount(r.amount)}</td>
                  <td className="py-2 text-right text-text-muted">{fmtUsd(r.usdAmount)}</td>
                  <td className="py-2 text-right text-text-muted">{r.count}</td>
                </tr>
              ))}
              {s.byToken.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-text-muted">No data</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <h2 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wide">Fees by Network</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-text-muted border-b border-border"><th className="text-left py-1.5">Network</th><th className="text-right py-1.5">Collected</th><th className="text-right py-1.5">USD</th><th className="text-right py-1.5">Count</th></tr></thead>
            <tbody>
              {s.byChain.map(r => (
                <tr key={r.chain} className="border-b border-border hover:bg-surface">
                  <td className="py-2 font-mono text-primary">{CHAIN_LABEL[r.chain] ?? r.chain}</td>
                  <td className="py-2 text-right text-text-primary">{fmtAmount(r.amount)}</td>
                  <td className="py-2 text-right text-text-muted">{fmtUsd(r.usdAmount)}</td>
                  <td className="py-2 text-right text-text-muted">{r.count}</td>
                </tr>
              ))}
              {s.byChain.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-text-muted">No data</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 30-day chart */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wide">Daily Fees — Last 30 Days</h2>
        <DailyChart data={s.dailyChart} />
        <p className="text-xs text-text-muted mt-2">Each bar = one day. Hover for exact amount.</p>
      </div>

      {/* Fee history */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Fee Collection History</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <input type="text" placeholder="Token" value={feeToken} onChange={e => { setFeeToken(e.target.value.toUpperCase()); setFeePage(1) }} className="bg-white border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-24" />
            <input type="text" placeholder="Network" value={feeChain} onChange={e => { setFeeChain(e.target.value.toUpperCase()); setFeePage(1) }} className="bg-white border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-28" />
            <input type="date" value={feeFrom} onChange={e => { setFeeFrom(e.target.value); setFeePage(1) }} className="bg-white border border-border rounded px-2 py-1 text-text-primary w-34" />
            <span className="text-text-muted self-center">→</span>
            <input type="date" value={feeTo} onChange={e => { setFeeTo(e.target.value); setFeePage(1) }} className="bg-white border border-border rounded px-2 py-1 text-text-primary w-34" />
            <input type="text" placeholder="Search TX" value={feeSearch} onChange={e => { setFeeSearch(e.target.value); setFeePage(1) }} className="bg-white border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-36" />
            {(feeToken || feeChain || feeFrom || feeTo || feeSearch) && (
              <button onClick={() => { setFeeToken(''); setFeeChain(''); setFeeFrom(''); setFeeTo(''); setFeeSearch(''); setFeePage(1) }} className="text-text-muted hover:text-text-primary border border-border rounded px-2 py-1">Clear</button>
            )}
          </div>
        </div>
        {feeEntries.length === 0 ? (
          <p className="text-text-muted text-sm py-4">No fee entries found.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border">
                    <th className="text-left py-2">Date</th>
                    <th className="text-left py-2">Network</th>
                    <th className="text-right py-2">Fee</th>
                    <th className="text-right py-2">USD</th>
                    <th className="text-left py-2 pl-3">TX Hash</th>
                    <th className="text-left py-2 pl-3">Withdrawal</th>
                  </tr>
                </thead>
                <tbody>
                  {feeEntries.map(e => {
                    const url  = txUrl(e.chain, e.txHash)
                    const wdId = extractWithdrawalId(e.sourceKey)
                    return (
                      <tr key={e.id} className="border-b border-border hover:bg-surface">
                        <td className="py-2 text-text-muted whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                        <td className="py-2 text-primary">{CHAIN_LABEL[e.chain] ?? e.chain}</td>
                        <td className="py-2 text-right font-mono text-emerald-600">{fmtAmount(e.tokenAmount)} {e.tokenSymbol}</td>
                        <td className="py-2 text-right text-text-muted">{fmtUsd(e.usdAmount)}</td>
                        <td className="py-2 pl-3">
                          {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">{e.txHash?.slice(0, 10)}…</a> : <span className="font-mono text-text-muted">{e.txHash?.slice(0, 10) ?? '—'}</span>}
                        </td>
                        <td className="py-2 pl-3">
                          {wdId ? <a href={`/admin/withdrawals?search=${wdId}`} className="font-mono text-text-muted hover:text-text-primary">{wdId.slice(-8)}</a> : <span className="text-text-muted">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {feePagination.pages > 1 && (
              <div className="flex items-center justify-between mt-3 text-xs text-text-muted">
                <span>{feePagination.total} total</span>
                <div className="flex gap-2">
                  <button disabled={feePage <= 1} onClick={() => setFeePage(p => p - 1)} className="px-2 py-1 border border-border rounded disabled:opacity-30">Prev</button>
                  <span>{feePage}/{feePagination.pages}</span>
                  <button disabled={feePage >= feePagination.pages} onClick={() => setFeePage(p => p + 1)} className="px-2 py-1 border border-border rounded disabled:opacity-30">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Info box */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-700 space-y-1">
        <p className="font-semibold text-blue-800">How it works</p>
        <p>When a user withdraws, they receive <strong>amount − fee</strong>. The fee stays in the hot wallet and is recorded as a <code>platform_fee</code> ledger entry.</p>
        <p>Clicking <strong>Sweep →</strong> sends the available fee balance on-chain to the treasury wallet. The system verifies the available amount is ≤ what the ledger records as platform-owned, preventing accidental sweeping of user deposits.</p>
        <p>TRON (TRC20) fees must be swept manually from the TRON treasury wallet using your wallet app.</p>
      </div>

      {/* Sweep confirmation modal */}
      {sweepModal && (
        <SweepModal
          row={sweepModal}
          treasuryAddress={s.treasuryAddresses.evm}
          onConfirm={amount => doSweep(sweepModal, amount)}
          onClose={() => setSweepModal(null)}
          sweeping={sweeping}
        />
      )}
    </div>
  )
}
