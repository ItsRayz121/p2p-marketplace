'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RevenueSummary {
  allTime:   { totalTokenFees: number; totalUsdFees: number; count: number }
  today:     { totalTokenFees: number; totalUsdFees: number; count: number }
  thisWeek:  { totalTokenFees: number; totalUsdFees: number }
  thisMonth: { totalTokenFees: number; totalUsdFees: number }
  byToken: Array<{ token: string; amount: number; usdAmount: number; count: number }>
  byChain: Array<{ chain: string; amount: number; usdAmount: number; count: number }>
  dailyChart: Array<{ date: string; tokenAmount: number; usdAmount: number; count: number }>
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

interface FeeHistoryResponse {
  entries: FeeEntry[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHAIN_EXPLORER: Record<string, string> = {
  BSC:      'https://bscscan.com/tx/',
  ETHEREUM: 'https://etherscan.io/tx/',
  BASE:     'https://basescan.org/tx/',
  ARB:      'https://arbiscan.io/tx/',
  OP:       'https://optimistic.etherscan.io/tx/',
  MATIC:    'https://polygonscan.com/tx/',
  TRON:     'https://tronscan.org/#/transaction/',
}

function explorerUrl(chain: string, txHash: string): string | null {
  const base = CHAIN_EXPLORER[chain.toUpperCase()]
  return base ? base + txHash : null
}

function fmtAmount(amount: string | number | null): string {
  if (amount === null || amount === undefined) return '—'
  const n = Number(amount)
  return isNaN(n) ? '—' : n.toFixed(6).replace(/\.?0+$/, '') || '0'
}

function fmtUsd(amount: string | number | null): string {
  if (amount === null || amount === undefined) return '—'
  const n = Number(amount)
  return isNaN(n) ? '—' : `$${n.toFixed(2)}`
}

// Extract withdrawal ID from sourceKey like "platform_fee:withdrawal:abc123"
function extractWithdrawalId(sourceKey: string | null): string | null {
  if (!sourceKey) return null
  const parts = sourceKey.split(':')
  return parts.length >= 3 ? (parts[2] ?? null) : null
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCard({ label, primary, secondary, sub }: {
  label: string; primary: string; secondary?: string; sub?: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{primary}</p>
      {secondary && <p className="text-sm text-gray-400 mt-0.5">{secondary}</p>}
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

// ─── Mini Bar Chart (30-day daily) ────────────────────────────────────────────

function DailyChart({ data }: { data: Array<{ date: string; tokenAmount: number; count: number }> }) {
  if (data.length === 0) return <p className="text-sm text-gray-500 py-4">No data yet.</p>

  const max = Math.max(...data.map(d => d.tokenAmount), 0.000001)

  return (
    <div className="flex items-end gap-0.5 h-20 w-full">
      {data.map(d => {
        const heightPct = Math.max((d.tokenAmount / max) * 100, 2)
        return (
          <div
            key={d.date}
            className="flex-1 bg-emerald-600 rounded-sm opacity-80 hover:opacity-100 transition-opacity cursor-default"
            style={{ height: `${heightPct}%` }}
            title={`${d.date}\n${fmtAmount(d.tokenAmount)} USDT (${d.count} fee${d.count !== 1 ? 's' : ''})`}
          />
        )
      })}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PlatformRevenuePage() {
  const [summary, setSummary] = useState<RevenueSummary | null>(null)
  const [history, setHistory] = useState<FeeHistoryResponse | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [filterToken, setFilterToken] = useState('')
  const [filterChain, setFilterChain] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [search, setSearch] = useState('')

  const fetchSummary = useCallback(async () => {
    try {
      const res = await adminApi.getPlatformRevenueSummary()
      setSummary((res as unknown as { data: RevenueSummary }).data)
      setSummaryError(null)
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : 'Failed to load summary')
    }
  }, [])

  const fetchHistory = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page: historyPage, limit: 20 }
      if (filterToken) params.token = filterToken
      if (filterChain) params.chain = filterChain
      if (filterFrom)  params.from  = filterFrom
      if (filterTo)    params.to    = filterTo
      if (search)      params.search = search
      const res = await adminApi.getPlatformFeeHistory(params)
      setHistory((res as unknown as { data: FeeHistoryResponse }).data)
      setHistoryError(null)
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load history')
    }
  }, [historyPage, filterToken, filterChain, filterFrom, filterTo, search])

  usePolling(fetchSummary, 30_000, true)
  usePolling(fetchHistory, 30_000, true)

  if (!summary && !summaryError) return <LoadingState />
  if (summaryError && !summary) return <ErrorState title={summaryError} onRetry={fetchSummary} />

  const s = summary!

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Platform Revenue</h1>
        <p className="text-sm text-gray-400 mt-1">
          Withdrawal fees collected by the platform — tracked via ledger entries, physically held in the hot wallet.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="All-Time Fees"
          primary={`${fmtAmount(s.allTime.totalTokenFees)} USDT`}
          secondary={fmtUsd(s.allTime.totalUsdFees)}
          sub={`${s.allTime.count} withdrawal${s.allTime.count !== 1 ? 's' : ''}`}
        />
        <SummaryCard
          label="Today"
          primary={`${fmtAmount(s.today.totalTokenFees)} USDT`}
          secondary={fmtUsd(s.today.totalUsdFees)}
          sub={`${s.today.count} fee${s.today.count !== 1 ? 's' : ''} today`}
        />
        <SummaryCard
          label="This Week"
          primary={`${fmtAmount(s.thisWeek.totalTokenFees)} USDT`}
          secondary={fmtUsd(s.thisWeek.totalUsdFees)}
        />
        <SummaryCard
          label="This Month"
          primary={`${fmtAmount(s.thisMonth.totalTokenFees)} USDT`}
          secondary={fmtUsd(s.thisMonth.totalUsdFees)}
        />
      </div>

      {/* Two-column: by token + by chain */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* By token */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wide">Fees by Token</h2>
          {s.byToken.length === 0 ? (
            <p className="text-sm text-gray-500">No fees recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1.5">Token</th>
                  <th className="text-right py-1.5">Amount</th>
                  <th className="text-right py-1.5">USD Value</th>
                  <th className="text-right py-1.5">Count</th>
                </tr>
              </thead>
              <tbody>
                {s.byToken.map(r => (
                  <tr key={r.token} className="border-b border-gray-800 hover:bg-gray-800/40">
                    <td className="py-2 font-mono text-emerald-400">{r.token}</td>
                    <td className="py-2 text-right text-white">{fmtAmount(r.amount)}</td>
                    <td className="py-2 text-right text-gray-400">{fmtUsd(r.usdAmount)}</td>
                    <td className="py-2 text-right text-gray-500">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* By chain/network */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wide">Fees by Network</h2>
          {s.byChain.length === 0 ? (
            <p className="text-sm text-gray-500">No fees recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1.5">Network</th>
                  <th className="text-right py-1.5">Amount</th>
                  <th className="text-right py-1.5">USD Value</th>
                  <th className="text-right py-1.5">Count</th>
                </tr>
              </thead>
              <tbody>
                {s.byChain.map(r => (
                  <tr key={r.chain} className="border-b border-gray-800 hover:bg-gray-800/40">
                    <td className="py-2 font-mono text-blue-400">{r.chain}</td>
                    <td className="py-2 text-right text-white">{fmtAmount(r.amount)}</td>
                    <td className="py-2 text-right text-gray-400">{fmtUsd(r.usdAmount)}</td>
                    <td className="py-2 text-right text-gray-500">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 30-day daily chart */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wide">Daily Fees — Last 30 Days</h2>
        <DailyChart data={s.dailyChart} />
        <p className="text-xs text-gray-600 mt-2">Each bar = one day. Hover for exact amount.</p>
      </div>

      {/* Fee history */}
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Fee History</h2>
          {/* Filters */}
          <div className="flex flex-wrap gap-2 text-xs">
            <input
              type="text"
              placeholder="Token (e.g. USDT)"
              value={filterToken}
              onChange={e => { setFilterToken(e.target.value.toUpperCase()); setHistoryPage(1) }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white placeholder-gray-500 w-28"
            />
            <input
              type="text"
              placeholder="Network (e.g. BSC)"
              value={filterChain}
              onChange={e => { setFilterChain(e.target.value.toUpperCase()); setHistoryPage(1) }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white placeholder-gray-500 w-32"
            />
            <input
              type="date"
              value={filterFrom}
              onChange={e => { setFilterFrom(e.target.value); setHistoryPage(1) }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white w-36"
            />
            <span className="text-gray-500 self-center">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={e => { setFilterTo(e.target.value); setHistoryPage(1) }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white w-36"
            />
            <input
              type="text"
              placeholder="Search TX / note"
              value={search}
              onChange={e => { setSearch(e.target.value); setHistoryPage(1) }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white placeholder-gray-500 w-40"
            />
            {(filterToken || filterChain || filterFrom || filterTo || search) && (
              <button
                onClick={() => { setFilterToken(''); setFilterChain(''); setFilterFrom(''); setFilterTo(''); setSearch(''); setHistoryPage(1) }}
                className="text-gray-400 hover:text-white border border-gray-600 rounded px-2 py-1"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {historyError && <p className="text-red-400 text-sm mb-3">{historyError}</p>}

        {!history ? (
          <p className="text-gray-500 text-sm py-4">Loading...</p>
        ) : history.entries.length === 0 ? (
          <p className="text-gray-500 text-sm py-4">No platform fee entries found.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-700">
                    <th className="text-left py-2">Date</th>
                    <th className="text-left py-2">Network</th>
                    <th className="text-right py-2">Fee Amount</th>
                    <th className="text-right py-2">USD Value</th>
                    <th className="text-left py-2 pl-4">TX Hash</th>
                    <th className="text-left py-2 pl-4">Withdrawal</th>
                    <th className="text-left py-2 pl-4">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {history.entries.map(e => {
                    const wdId = extractWithdrawalId(e.sourceKey)
                    const txUrl = e.txHash ? explorerUrl(e.chain, e.txHash) : null
                    return (
                      <tr key={e.id} className="border-b border-gray-800 hover:bg-gray-800/40 text-xs">
                        <td className="py-2 text-gray-400 whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                        <td className="py-2 font-mono text-blue-400">{e.chain}</td>
                        <td className="py-2 text-right font-mono text-emerald-400">
                          {fmtAmount(e.tokenAmount)} {e.tokenSymbol ?? ''}
                        </td>
                        <td className="py-2 text-right text-gray-400">{fmtUsd(e.usdAmount)}</td>
                        <td className="py-2 pl-4">
                          {e.txHash ? (
                            txUrl ? (
                              <a href={txUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:underline">
                                {e.txHash.slice(0, 10)}…
                              </a>
                            ) : (
                              <span className="font-mono text-gray-400">{e.txHash.slice(0, 10)}…</span>
                            )
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                        <td className="py-2 pl-4">
                          {wdId ? (
                            <a href={`/admin/withdrawals?search=${wdId}`} className="font-mono text-gray-400 hover:text-white hover:underline text-xs">
                              {wdId.slice(-8)}
                            </a>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                        <td className="py-2 pl-4 text-gray-500 max-w-xs truncate" title={e.notes ?? ''}>
                          {e.notes ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {history.pagination.pages > 1 && (
              <div className="flex items-center justify-between mt-4 text-xs text-gray-400">
                <span>{history.pagination.total} entries total</span>
                <div className="flex gap-2">
                  <button
                    disabled={historyPage <= 1}
                    onClick={() => setHistoryPage(p => p - 1)}
                    className="px-3 py-1 rounded border border-gray-600 disabled:opacity-30 hover:bg-gray-700"
                  >
                    Prev
                  </button>
                  <span className="px-2 py-1">{historyPage} / {history.pagination.pages}</span>
                  <button
                    disabled={historyPage >= history.pagination.pages}
                    onClick={() => setHistoryPage(p => p + 1)}
                    className="px-3 py-1 rounded border border-gray-600 disabled:opacity-30 hover:bg-gray-700"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Info box */}
      <div className="bg-blue-950/40 border border-blue-800/40 rounded-lg p-4 text-xs text-blue-300 space-y-1">
        <p className="font-semibold text-blue-200">How platform fees work</p>
        <p>When a user withdraws, they receive <strong>amount − fee</strong> on-chain. The <strong>fee stays in the hot wallet</strong> and is recorded here as platform revenue.</p>
        <p>These funds are platform-owned and separate from user balances. To physically move them to the treasury wallet, use the Treasury Sweep feature (coming soon).</p>
        <p>Ledger entries are append-only and idempotent — each withdrawal generates exactly one <code>platform_fee</code> entry.</p>
      </div>
    </div>
  )
}
