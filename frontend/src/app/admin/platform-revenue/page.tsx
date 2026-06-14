'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/store/auth.store'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RevenueSummary {
  allTime:   { totalTokenFees: number; totalUsdFees: number; totalSwept: number; available: number; count: number }
  today:     { totalTokenFees: number; totalUsdFees: number; count: number }
  thisWeek:  { totalTokenFees: number; totalUsdFees: number }
  thisMonth: { totalTokenFees: number; totalUsdFees: number }
  byToken: Array<{ token: string; amount: number; usdAmount: number; count: number }>
  byChain: Array<{ chain: string; amount: number; usdAmount: number; count: number }>
  dailyChart: Array<{ date: string; tokenAmount: number; usdAmount: number; count: number }>
  treasuryAddresses: { evm: string | null; tron: string | null }
}

type WithdrawFamily = 'evm' | 'tron' | 'aptos'

interface WithdrawableRow {
  token: string
  chain: string
  family: string | null
  network: string | null
  onChain: number
  userLiability: number
  pendingOut: number
  buffer: number
  available: number
  destinationSet: boolean
  supported: boolean
}

interface WithdrawConfig {
  destinations: { evm: string | null; tron: string | null; aptos: string | null }
  withdrawable: WithdrawableRow[]
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

interface WithdrawResult {
  txHash: string
  destination: string
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
  APT:  'https://explorer.aptoslabs.com/txn/',
}

const CHAIN_LABEL: Record<string, string> = {
  BSC: 'BNB Chain (BEP20)', ETH: 'Ethereum (ERC20)', BASE: 'Base',
  ARB: 'Arbitrum', OP: 'Optimism', MATIC: 'Polygon', TRON: 'TRON (TRC20)',
  APT: 'Aptos',
}

const FAMILY_LABEL: Record<WithdrawFamily, string> = {
  evm: 'EVM (BNB Chain, Ethereum, Base, Arbitrum, Optimism, Polygon)',
  tron: 'TRON (TRC20)',
  aptos: 'Aptos',
}

function txUrl(chain: string, hash: string | null): string | null {
  if (!hash) return null
  const base = CHAIN_EXPLORER_TX[chain.toUpperCase()]
  return base ? base + hash : null
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

function DailyChart({ data }: { data: Array<{ date: string; tokenAmount: number; usdAmount?: number; count: number }> }) {
  const byDate = new Map(data.map(d => [d.date, d]))
  const days: Array<{ date: string; tokenAmount: number; usdAmount: number; count: number }> = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(today)
    dt.setDate(today.getDate() - i)
    const key = dt.toISOString().slice(0, 10)
    const hit = byDate.get(key)
    days.push({
      date: key,
      tokenAmount: hit?.tokenAmount ?? 0,
      usdAmount: hit?.usdAmount ?? 0,
      count: hit?.count ?? 0,
    })
  }

  const total = days.reduce((sum, d) => sum + d.tokenAmount, 0)
  if (total <= 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-center">
        <p className="text-sm font-medium text-text-secondary">No fees collected in the last 30 days</p>
        <p className="text-xs text-text-muted mt-1">Daily fee bars will appear here once withdrawals start generating fees.</p>
      </div>
    )
  }

  const max = Math.max(...days.map(d => d.tokenAmount), 0.000001)
  const fmtLabel = (iso: string) => {
    const [, m, d] = iso.split('-')
    return `${Number(m)}/${Number(d)}`
  }

  return (
    <div>
      <div className="flex items-end gap-1 h-40 w-full">
        {days.map(d => {
          const hasData = d.tokenAmount > 0
          return (
            <div key={d.date} className="group relative flex-1 h-full flex items-end">
              <div
                className={`w-full rounded-t-sm transition-colors ${hasData ? 'bg-emerald-500 group-hover:bg-emerald-600' : 'bg-border/60'}`}
                style={{ height: hasData ? `${Math.max((d.tokenAmount / max) * 100, 4)}%` : '3px' }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap bg-text-primary text-white text-[11px] rounded-md px-2 py-1 shadow-lg">
                <p className="font-semibold">{fmtLabel(d.date)}</p>
                <p>{fmtAmount(d.tokenAmount)} USDT</p>
                <p className="opacity-80">{fmtUsd(d.usdAmount)} · {d.count} fee{d.count !== 1 ? 's' : ''}</p>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-2 text-[10px] text-text-muted">
        <span>{fmtLabel(days[0]!.date)}</span>
        <span>{fmtLabel(days[Math.floor(days.length / 2)]!.date)}</span>
        <span>{fmtLabel(days[days.length - 1]!.date)} (today)</span>
      </div>
    </div>
  )
}

// ─── Withdrawal Destination editor ────────────────────────────────────────────

function DestinationEditor({ destinations, isSuperAdmin, onSaved }: {
  destinations: WithdrawConfig['destinations']
  isSuperAdmin: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState<Record<WithdrawFamily, string>>({ evm: '', tron: '', aptos: '' })
  const [saving, setSaving]   = useState<WithdrawFamily | null>(null)
  const [err, setErr]         = useState<string | null>(null)

  const families: WithdrawFamily[] = ['evm', 'tron', 'aptos']

  async function save(family: WithdrawFamily) {
    const address = (editing[family] ?? '').trim()
    if (!address) return
    setSaving(family); setErr(null)
    try {
      await adminApi.setWithdrawDestination({ family, address })
      setEditing(e => ({ ...e, [family]: '' }))
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save destination')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">Withdrawal Destination (Your External Wallet)</h2>
      <p className="text-xs text-text-muted mb-3">
        Funds are withdrawn from the hot wallet to <strong>these</strong> addresses. Set the wallet you control for each network. {isSuperAdmin ? '' : 'Only a super-admin can change these.'}
      </p>
      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      <div className="space-y-3">
        {families.map(family => {
          const current = destinations[family]
          return (
            <div key={family} className="border border-border rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-text-primary uppercase">{family}</span>
                <span className="text-[10px] text-text-muted">{FAMILY_LABEL[family]}</span>
              </div>
              <p className="text-xs font-mono break-all mb-2">
                {current
                  ? <span className="text-emerald-600">{current}</span>
                  : <span className="text-amber-600">Not set — withdrawals disabled for this network</span>}
              </p>
              {isSuperAdmin && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editing[family]}
                    onChange={e => setEditing(s => ({ ...s, [family]: e.target.value }))}
                    placeholder={current ? 'Replace address…' : 'Paste your wallet address…'}
                    className="flex-1 bg-surface border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted text-xs font-mono"
                  />
                  <Button variant="secondary" onClick={() => save(family)} disabled={saving === family || !(editing[family] ?? '').trim()}>
                    {saving === family ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Withdraw Confirm Modal ────────────────────────────────────────────────────

interface WithdrawModalProps {
  row: WithdrawableRow
  destination: string | null
  onConfirm: (amount: number) => void
  onClose: () => void
  busy: boolean
}

function WithdrawModal({ row, destination, onConfirm, onClose, busy }: WithdrawModalProps) {
  const [customAmount, setCustomAmount] = useState<string>('')
  const [mode, setMode] = useState<'all' | 'custom'>('all')

  const amount = mode === 'all' ? row.available : (parseFloat(customAmount) || 0)
  const valid  = amount > 0 && amount <= row.available && !!destination

  return (
    <Modal isOpen onClose={onClose} title="Withdraw Platform Revenue to External Wallet">
      <div className="space-y-4 text-sm">
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-amber-700 text-xs space-y-1">
          <p className="font-semibold">Safety notice</p>
          <p>This sends funds <strong>on-chain</strong> from the hot wallet to your external wallet. The transaction cannot be reversed.</p>
          <p>The amount is capped at <strong>platform-owned funds only</strong> — on-chain balance minus what is owed to users and minus pending user withdrawals. User funds can never be withdrawn here.</p>
        </div>

        <div className="bg-surface border border-border rounded p-3 space-y-2 text-xs font-mono">
          <div className="flex justify-between"><span className="text-text-muted">Token</span><span className="text-emerald-600">{row.token}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Network</span><span className="text-primary">{CHAIN_LABEL[row.chain] ?? row.chain}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">On-chain balance</span><span className="text-text-secondary">{fmtAmount(row.onChain)}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Owed to users</span><span className="text-text-secondary">−{fmtAmount(row.userLiability)}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Pending withdrawals</span><span className="text-text-secondary">−{fmtAmount(row.pendingOut)}</span></div>
          {row.buffer > 0 && <div className="flex justify-between"><span className="text-text-muted">Safety reserve</span><span className="text-text-secondary">−{fmtAmount(row.buffer)}</span></div>}
          <div className="flex justify-between border-t border-border pt-1"><span className="text-text-muted">Available to withdraw</span><span className="text-text-primary font-semibold">{fmtAmount(row.available)} {row.token}</span></div>
          <div className="flex justify-between"><span className="text-text-muted">Destination</span><span className="text-text-secondary break-all">{destination ?? '— not set —'}</span></div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} className="accent-emerald-600" />
            <span>Withdraw all available — <strong>{fmtAmount(row.available)} {row.token}</strong></span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} className="accent-emerald-600" />
            <span>Custom amount</span>
          </label>
          {mode === 'custom' && (
            <div className="ml-6 flex items-center gap-2">
              <input
                type="number" min="0" max={row.available} step="0.000001"
                value={customAmount} onChange={e => setCustomAmount(e.target.value)}
                placeholder="0.000000"
                className="bg-surface border border-border rounded px-2 py-1 text-text-primary w-36 text-sm"
              />
              <span className="text-text-muted text-xs">{row.token} (max {fmtAmount(row.available)})</span>
            </div>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="primary" onClick={() => valid && onConfirm(amount)} disabled={!valid || busy} className="flex-1">
            {busy ? 'Sending on-chain…' : `Confirm Withdraw ${fmtAmount(amount)} ${row.token}`}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlatformRevenuePage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  const [summary, setSummary]             = useState<RevenueSummary | null>(null)
  const [summaryError, setSummaryError]   = useState<string | null>(null)

  const [wConfig, setWConfig]             = useState<WithdrawConfig | null>(null)

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

  const [withdrawModal, setWithdrawModal] = useState<WithdrawableRow | null>(null)
  const [withdrawing, setWithdrawing]     = useState(false)
  const [withdrawResult, setWithdrawResult] = useState<WithdrawResult | null>(null)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await adminApi.getPlatformRevenueSummary()
      setSummary(res as unknown as RevenueSummary)
      setSummaryError(null)
    } catch (e) { setSummaryError(e instanceof Error ? e.message : 'Failed to load') }
  }, [])

  const fetchWithdrawConfig = useCallback(async () => {
    try {
      const res = await adminApi.getWithdrawConfig()
      setWConfig(res)
    } catch { /* silent */ }
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

  usePolling(fetchSummary,        30_000, true)
  usePolling(fetchWithdrawConfig, 30_000, true)
  usePolling(fetchFees,           30_000, true)
  usePolling(fetchSweepHistory,   30_000, true)

  async function doWithdraw(row: WithdrawableRow, amount: number) {
    setWithdrawing(true)
    setWithdrawError(null)
    setWithdrawResult(null)
    try {
      const res = await adminApi.withdrawRevenue({ tokenSymbol: row.token, chain: row.chain, amount })
      setWithdrawResult(res)
      setWithdrawModal(null)
      void fetchWithdrawConfig()
      void fetchSweepHistory()
    } catch (e) {
      setWithdrawError(e instanceof Error ? e.message : 'Withdrawal failed')
      setWithdrawModal(null)
    } finally {
      setWithdrawing(false)
    }
  }

  function destinationFor(row: WithdrawableRow): string | null {
    if (!wConfig) return null
    const fam = row.family
    if (fam === 'evm' || fam === 'tron' || fam === 'aptos') return wConfig.destinations[fam] ?? null
    return null
  }

  if (!summary && !summaryError) return <LoadingState />
  if (summaryError && !summary)  return <ErrorState title={summaryError} onRetry={fetchSummary} />

  const s = summary!
  const withdrawable = wConfig?.withdrawable ?? []

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Revenue</h1>
        <p className="text-sm text-text-muted mt-1">
          Platform-owned funds in the hot wallet. Withdraw your revenue to an external wallet you control.
        </p>
      </div>

      {/* Withdraw result banner */}
      {withdrawResult && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-sm">
          <p className="font-semibold text-emerald-700 mb-2">Withdrawal confirmed on-chain ✓</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs font-mono text-text-secondary">
            <span className="text-text-muted">Amount</span>
            <span>{fmtAmount(withdrawResult.amount)} {withdrawResult.tokenSymbol} on {CHAIN_LABEL[withdrawResult.chain] ?? withdrawResult.chain}</span>
            <span className="text-text-muted">Destination</span>
            <span className="break-all">{withdrawResult.destination}</span>
            <span className="text-text-muted">TX Hash</span>
            <span>
              {txUrl(withdrawResult.chain, withdrawResult.txHash) ? (
                <a href={txUrl(withdrawResult.chain, withdrawResult.txHash)!} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {withdrawResult.txHash.slice(0, 20)}…
                </a>
              ) : withdrawResult.txHash}
            </span>
            <span className="text-text-muted">Remaining available</span>
            <span>{fmtAmount(withdrawResult.remainingAvailable)} {withdrawResult.tokenSymbol}</span>
          </div>
          <button onClick={() => setWithdrawResult(null)} className="mt-3 text-xs text-text-muted hover:text-text-primary">Dismiss</button>
        </div>
      )}

      {/* Withdraw error banner */}
      {withdrawError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <p className="font-semibold mb-1">Withdrawal failed</p>
          <p className="text-xs">{withdrawError}</p>
          <button onClick={() => setWithdrawError(null)} className="mt-2 text-xs text-text-muted hover:text-text-primary">Dismiss</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Withdrawal Fees (All Time)" primary={`${fmtAmount(s.allTime.totalTokenFees)} USDT`} sub={`${fmtUsd(s.allTime.totalUsdFees)} · ${s.allTime.count} fee${s.allTime.count !== 1 ? 's' : ''}`} />
        <StatCard label="Today" primary={`${fmtAmount(s.today.totalTokenFees)} USDT`} sub={`${fmtUsd(s.today.totalUsdFees)} · ${s.today.count} fee${s.today.count !== 1 ? 's' : ''}`} />
        <StatCard label="This Week" primary={`${fmtAmount(s.thisWeek.totalTokenFees)} USDT`} sub={fmtUsd(s.thisWeek.totalUsdFees)} />
        <StatCard label="This Month" primary={`${fmtAmount(s.thisMonth.totalTokenFees)} USDT`} sub={fmtUsd(s.thisMonth.totalUsdFees)} />
      </div>

      {/* Withdrawal destination editor */}
      {wConfig && (
        <DestinationEditor destinations={wConfig.destinations} isSuperAdmin={isSuperAdmin} onSaved={fetchWithdrawConfig} />
      )}

      {/* Withdraw to external wallet */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">Withdraw Platform Revenue to External Wallet</h2>
        <p className="text-xs text-text-muted mb-3">
          &ldquo;Available&rdquo; = on-chain balance − funds owed to users − pending user withdrawals. Only this platform-owned headroom can be withdrawn.
        </p>
        {!wConfig ? (
          <p className="text-sm text-text-muted">Loading balances…</p>
        ) : withdrawable.length === 0 ? (
          <p className="text-sm text-text-muted">No revenue recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-text-muted border-b border-border">
                  <th className="text-left py-2">Token</th>
                  <th className="text-left py-2">Network</th>
                  <th className="text-right py-2">On-chain</th>
                  <th className="text-right py-2">Owed to users</th>
                  <th className="text-right py-2 text-emerald-600">Available</th>
                  <th className="text-right py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {withdrawable.map(row => {
                  const dest = destinationFor(row)
                  const canWithdraw = isSuperAdmin && row.supported && row.available > 0 && !!dest
                  return (
                    <tr key={`${row.token}:${row.chain}`} className="border-b border-border hover:bg-surface">
                      <td className="py-2 font-mono text-emerald-600">{row.token}</td>
                      <td className="py-2 text-primary">{CHAIN_LABEL[row.chain] ?? row.chain}</td>
                      <td className="py-2 text-right text-text-secondary font-mono">{fmtAmount(row.onChain)}</td>
                      <td className="py-2 text-right text-text-muted font-mono">{fmtAmount(row.userLiability)}</td>
                      <td className="py-2 text-right font-mono font-semibold text-text-primary">{fmtAmount(row.available)}</td>
                      <td className="py-2 text-right">
                        {canWithdraw ? (
                          <button onClick={() => setWithdrawModal(row)} className="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition-colors">
                            Withdraw →
                          </button>
                        ) : !row.supported ? (
                          <span className="text-xs text-amber-600">Manual</span>
                        ) : !dest ? (
                          <span className="text-xs text-amber-600">Set destination</span>
                        ) : row.available <= 0 ? (
                          <span className="text-xs text-text-muted">None</span>
                        ) : (
                          <span className="text-xs text-text-muted">Super-admin</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Withdrawal history */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">Withdrawal History</h2>
        {sweepHistory.length === 0 ? (
          <p className="text-sm text-text-muted">No withdrawals yet.</p>
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
                    <th className="text-left py-2 pl-4">To</th>
                  </tr>
                </thead>
                <tbody>
                  {sweepHistory.map(e => {
                    const url = txUrl(e.chain, e.txHash)
                    return (
                      <tr key={e.id} className="border-b border-border hover:bg-surface">
                        <td className="py-2 text-text-muted whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                        <td className="py-2 text-primary">{CHAIN_LABEL[e.chain] ?? e.chain}</td>
                        <td className="py-2 text-right font-mono text-emerald-600">{fmtAmount(e.tokenAmount)} {e.tokenSymbol}</td>
                        <td className="py-2 pl-4">
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">{e.txHash?.slice(0, 12)}…</a>
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
            <input type="text" placeholder="Token" value={feeToken} onChange={e => { setFeeToken(e.target.value.toUpperCase()); setFeePage(1) }} className="bg-surface border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-24" />
            <input type="text" placeholder="Network" value={feeChain} onChange={e => { setFeeChain(e.target.value.toUpperCase()); setFeePage(1) }} className="bg-surface border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-28" />
            <input type="date" value={feeFrom} onChange={e => { setFeeFrom(e.target.value); setFeePage(1) }} className="bg-surface border border-border rounded px-2 py-1 text-text-primary w-34" />
            <span className="text-text-muted self-center">→</span>
            <input type="date" value={feeTo} onChange={e => { setFeeTo(e.target.value); setFeePage(1) }} className="bg-surface border border-border rounded px-2 py-1 text-text-primary w-34" />
            <input type="text" placeholder="Search TX" value={feeSearch} onChange={e => { setFeeSearch(e.target.value); setFeePage(1) }} className="bg-surface border border-border rounded px-2 py-1 text-text-primary placeholder-text-muted w-36" />
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
        <p>The hot wallet holds both user balances and platform revenue (gas-order payments + withdrawal fees). The <strong>Available</strong> figure subtracts everything owed to users and every pending user withdrawal, so only platform-owned funds can ever be withdrawn.</p>
        <p>Clicking <strong>Withdraw →</strong> sends that amount on-chain to the external wallet you configured above, and waits for on-chain confirmation before recording it.</p>
        <p>TRON (TRC20) and other non-EVM/Aptos networks are withdrawn manually for now.</p>
      </div>

      {/* Withdraw confirmation modal */}
      {withdrawModal && (
        <WithdrawModal
          row={withdrawModal}
          destination={destinationFor(withdrawModal)}
          onConfirm={amount => doWithdraw(withdrawModal, amount)}
          onClose={() => setWithdrawModal(null)}
          busy={withdrawing}
        />
      )}
    </div>
  )
}
