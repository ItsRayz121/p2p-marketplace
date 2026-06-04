'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Activity } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth.store'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { chainDisplayName } from '@/lib/chainDisplayName'

// ─── Types ────────────────────────────────────────────────────────────────────

type LedgerEntry = {
  id: string
  entryType: string
  chain: string
  nativeAmount: string
  nativeSymbol: string
  tokenSymbol: string | null
  tokenAmount: string | null
  usdAmount: string
  txHash: string | null
  fromAddress: string | null
  toAddress: string | null
  notes: string | null
  createdAt: string
  relatedOrder: { orderRef: string; status: string; paymentCoin: string; paymentNetwork: string } | null
}

type LiveBalance = {
  chain: string
  address: string
  balance: number | null
  balanceUsd: number | null
  nativeSymbol: string
  tokens: Array<{ symbol: string; name: string; balanceFormatted: number; tokenAddress: string }>
  fetchedAt: string
  error: string | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

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

const ENTRY_TYPES = Object.keys(ENTRY_TYPE_LABELS)

// Hook: fetch active gas chains from DB so dropdowns include SOL/TON/SUI automatically
function useGasChainIds() {
  const [chainIds, setChainIds] = useState<string[]>([])
  useEffect(() => {
    adminApi.getGasChains().then(({ chains }) => {
      const ids = chains
        .filter((c) => c.backendChainId)
        .map((c) => c.backendChainId as string)
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort()
      setChainIds(ids)
    }).catch(() => {})
  }, [])
  return chainIds
}

const EXPLORER_URL: Record<string, string> = {
  TRON:  'https://tronscan.org/#/address/',
  BSC:   'https://bscscan.com/address/',
  ETH:   'https://etherscan.io/address/',
  BASE:  'https://basescan.org/address/',
  ARB:   'https://arbiscan.io/address/',
  OP:    'https://optimistic.etherscan.io/address/',
  MATIC: 'https://polygonscan.com/address/',
  AVAX:  'https://snowtrace.io/address/',
  APT:   'https://explorer.aptoslabs.com/account/',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Live Balances Panel ──────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      onClick={copy}
      title="Copy address"
      className="ml-1 shrink-0 text-text-muted hover:text-text-primary transition-colors"
    >
      {copied ? (
        <svg className="w-3 h-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-4 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  )
}

function fmtTokenAmount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  if (n >= 1)         return n.toFixed(2)
  return n.toFixed(4)
}

function LiveBalancesPanel() {
  const [balances, setBalances]     = useState<LiveBalance[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [fetchedAt, setFetchedAt]   = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchBalances = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await adminApi.getHotWalletLiveBalances()
      setBalances(res.balances)
      setFetchedAt(res.fetchedAt)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch live balances')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void fetchBalances() }, [fetchBalances])
  useEffect(() => {
    const id = setInterval(() => void fetchBalances(true), 60_000)
    return () => clearInterval(id)
  }, [fetchBalances])

  return (
    <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Live Hot Wallet Balances</h2>
          {fetchedAt && (
            <p className="text-[11px] text-text-muted mt-0.5">
              {fmt(fetchedAt)} · auto-refreshes every 60s
            </p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => fetchBalances(true)} disabled={refreshing || loading}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {loading && <div className="p-4"><LoadingState message="Fetching live balances…" /></div>}
      {!loading && error && <div className="px-4 py-3 text-danger text-sm">{error}</div>}
      {!loading && !error && balances.length === 0 && (
        <div className="px-4 py-3 text-text-muted text-sm">No active hot wallets found.</div>
      )}

      {!loading && balances.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 divide-x divide-y divide-border">
          {balances.map((w) => {
            const explorerBase = EXPLORER_URL[w.chain]
            const explorerLink = explorerBase ? `${explorerBase}${w.address}` : null
            const visibleTokens = (w.tokens ?? [])
              .filter((t) => t.balanceFormatted > 0)
              .sort((a, b) => b.balanceFormatted - a.balanceFormatted)
              .slice(0, 6)
            const shortAddr = w.address.length > 14
              ? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`
              : w.address

            return (
              <div key={w.chain} className="p-3 flex flex-col gap-1.5 min-w-0">
                {/* Header row: chain logo + chain name + status dot + explorer */}
                <div className="flex items-center justify-between gap-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <EntityLogo type="chain" slug={w.chain} size="sm" />
                    <span className="font-bold text-xs text-text-primary truncate">{chainDisplayName(w.chain)}</span>
                    <span className="text-[10px] text-text-muted shrink-0">{w.nativeSymbol}</span>
                    <span className={cn(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      w.error        ? 'bg-danger'
                      : w.balance === null ? 'bg-gray-300'
                      : w.balance === 0    ? 'bg-warning'
                      : 'bg-success',
                    )} />
                  </div>
                  {explorerLink && (
                    <a href={explorerLink} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline shrink-0">↗</a>
                  )}
                </div>

                {/* Balance */}
                {w.error ? (
                  <p className="text-[10px] text-danger leading-tight truncate">{w.error}</p>
                ) : (
                  <div>
                    <p className={cn(
                      'text-sm font-bold leading-tight',
                      w.balance === null ? 'text-text-muted'
                      : w.balance === 0  ? 'text-warning'
                      : 'text-success',
                    )}>
                      {w.balance !== null ? w.balance.toFixed(4) : '—'}
                    </p>
                    {w.balanceUsd !== null && w.balanceUsd > 0 && (
                      <p className="text-[10px] text-text-muted">${w.balanceUsd.toFixed(2)}</p>
                    )}
                  </div>
                )}

                {/* Address + copy */}
                <div className="flex items-center min-w-0">
                  <span className="font-mono text-[9px] text-text-muted truncate" title={w.address}>
                    {shortAddr}
                  </span>
                  <CopyButton text={w.address} />
                </div>

                {/* Token chip summary — single line, no rows */}
                {visibleTokens.length > 0 && (
                  <p className="text-[9px] text-text-muted leading-tight truncate" title={
                    visibleTokens.map((t) => `${t.symbol} ${fmtTokenAmount(t.balanceFormatted)}`).join(' · ')
                  }>
                    {visibleTokens.map((t) => `${t.symbol} ${fmtTokenAmount(t.balanceFormatted)}`).join(' · ')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Manual Deposit Form ──────────────────────────────────────────────────────

function ManualDepositForm({ onSuccess, chains }: { onSuccess: () => void; chains: string[] }) {
  const [open, setOpen]           = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [success, setSuccess]     = useState<string | null>(null)

  const [chain, setChain]               = useState('')
  const [nativeAmount, setNativeAmount] = useState('')
  const [txHash, setTxHash]             = useState('')
  const [fromAddress, setFromAddress]   = useState('')
  const [toAddress, setToAddress]       = useState('')
  const [notes, setNotes]               = useState('')

  function reset() {
    setChain(''); setNativeAmount(''); setTxHash('')
    setFromAddress(''); setToAddress(''); setNotes('')
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const amt = parseFloat(nativeAmount)
    if (!chain || isNaN(amt) || amt <= 0) {
      setError('Chain and a valid amount > 0 are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await adminApi.logManualDeposit({
        chain,
        nativeAmount: amt,
        ...(txHash      ? { txHash }      : {}),
        ...(fromAddress ? { fromAddress } : {}),
        ...(toAddress   ? { toAddress }   : {}),
        ...(notes       ? { notes }       : {}),
      })
      setSuccess(`Manual deposit logged for ${amt} on ${chain}.`)
      setTimeout(() => setSuccess(null), 4000)
      reset()
      setOpen(false)
      onSuccess()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to log deposit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {success && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm mb-3">{success}</div>
      )}

      {!open ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          + Log Manual Deposit
        </Button>
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-text-primary">Log Manual Deposit</h3>
            <button onClick={() => { setOpen(false); reset() }} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Chain *</label>
                <select
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  value={chain}
                  onChange={(e) => setChain(e.target.value)}
                  required
                >
                  <option value="">Select chain…</option>
                  {chains.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Amount (native) *</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  placeholder="e.g. 11.5"
                  value={nativeAmount}
                  onChange={(e) => setNativeAmount(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Tx Hash</label>
              <input
                className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
                placeholder="0x… or transaction hash"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">From Address</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder="Sender address"
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">To Address (hot wallet)</label>
                <input
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder="Hot wallet address"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Notes</label>
              <input
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Manual POL top-up from OKX on 2026-05-22"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && <p className="text-danger text-sm">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? 'Saving…' : 'Log Deposit'}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => { setOpen(false); reset() }}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasWalletActivityPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'
  const gasChainIds = useGasChainIds()

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
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Gas Wallet Activity</h1>
          <p className="text-text-muted text-sm mt-0.5">
            Live balances + all hot-wallet financial movements.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm text-text-muted">{total.toLocaleString()} records</p>
          {isSuperAdmin && (
            <ManualDepositForm onSuccess={() => fetchActivity(1)} chains={gasChainIds} />
          )}
        </div>
      </div>

      {/* Live balances */}
      <LiveBalancesPanel />

      {/* Filters */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-4">
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
            {gasChainIds.map((c) => <option key={c} value={c}>{c}</option>)}
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
        <EmptyState icon={Activity} title="No wallet activity" description="No matching ledger entries found. Try adjusting filters." />
      )}

      {!loading && items.length > 0 && (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
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
                  const inflow    = isInflow(entry.entryType)
                  const usd       = parseFloat(entry.usdAmount)
                  // For ERC20 token payments (e.g. USDT), show tokenAmount + tokenSymbol instead of native
                  const hasToken  = entry.tokenSymbol && entry.tokenAmount
                  const amount    = hasToken ? parseFloat(entry.tokenAmount!) : parseFloat(entry.nativeAmount)
                  const symbol    = hasToken ? entry.tokenSymbol! : entry.nativeSymbol
                  const amountAbs = Math.abs(amount)

                  return (
                    <tr key={entry.id} className="hover:bg-surface/50 transition-colors">
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide whitespace-nowrap',
                          ENTRY_TYPE_COLORS[entry.entryType] ?? 'text-text-muted bg-surface',
                        )}>
                          {ENTRY_TYPE_LABELS[entry.entryType] ?? entry.entryType}
                        </span>
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <EntityLogo type="chain" slug={entry.chain} size="xs" />
                          <Badge variant="default" size="sm">{chainDisplayName(entry.chain)}</Badge>
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <p className={cn(
                          'text-sm font-semibold',
                          inflow ? 'text-success' : 'text-danger',
                        )}>
                          {inflow ? '+' : '−'}{amountAbs.toFixed(6)} {symbol}
                        </p>
                        {usd > 0 && (
                          <p className="text-[10px] text-text-muted">${usd.toFixed(4)}</p>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {entry.txHash ? (
                          (() => {
                            const explorerBase = EXPLORER_URL[entry.chain]
                            const txExplorer = explorerBase
                              ? (entry.chain === 'TRON'
                                  ? `https://tronscan.org/#/transaction/${entry.txHash}`
                                  : entry.chain === 'APT'
                                    ? `https://explorer.aptoslabs.com/txn/${entry.txHash}`
                                    : `${explorerBase.replace('/address/', '/tx/')}${entry.txHash}`)
                              : null
                            return txExplorer ? (
                              <a href={txExplorer} target="_blank" rel="noopener noreferrer"
                                className="font-mono text-[11px] text-primary hover:underline" title={entry.txHash}>
                                {shortHash(entry.txHash)}
                              </a>
                            ) : (
                              <span className="font-mono text-[11px] text-text-secondary" title={entry.txHash}>
                                {shortHash(entry.txHash)}
                              </span>
                            )
                          })()
                        ) : (
                          <span className="text-text-muted text-xs">—</span>
                        )}
                      </td>

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
