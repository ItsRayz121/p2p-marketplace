'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { adminApi } from '@/lib/api'
import { chainDisplayName } from '@/lib/chainDisplayName'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { TokenChainLogo } from '@/components/ui/TokenChainLogo'
import { CopyButton } from '@/components/ui/CopyButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft, RefreshCw } from 'lucide-react'

type WalletTokens = Awaited<ReturnType<typeof adminApi.getHotWalletTokens>>

function fmtBalance(n: number | null): string {
  if (n === null) return '—'
  if (n === 0) return '0'
  if (n < 0.0001) return n.toExponential(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}
function fmtUsd(n: number | null): string {
  if (n === null) return ''
  return `~$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

export default function HotWalletDetailPage() {
  const params = useParams<{ chain: string }>()
  const router = useRouter()
  const chain = (params?.chain ?? '').toString().toUpperCase()

  const [data, setData] = useState<WalletTokens | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      setData(await adminApi.getHotWalletTokens(chain))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet balances')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [chain])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingState message="Loading wallet balances…" />
  if (error)   return <ErrorState description={error} onRetry={() => void load()} />
  if (!data)   return null

  const tokenUsdTotal = data.tokens.reduce((sum, t) => sum + (t.usd ?? 0), 0)
  const totalUsd = (data.nativeUsd ?? 0) + tokenUsdTotal

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => router.push('/admin/gas')}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <ArrowLeft size={14} /> Back to Gas
        </button>
        <Button size="sm" variant="secondary" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/* Wallet card */}
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <EntityLogo type="chain" slug={chain} size="lg" />
          <div>
            <h1 className="text-base font-bold text-text-primary">{chainDisplayName(chain)} Hot Wallet</h1>
            <p className="text-xs text-text-muted">Live on-chain balances</p>
          </div>
        </div>
        <div className="bg-surface-alt rounded-lg p-3 flex items-start gap-2 border border-border">
          <p className="text-xs font-mono text-text-secondary break-all flex-1">{data.address}</p>
          <CopyButton text={data.address} />
        </div>
      </div>

      {/* Balance summary — quick cover: gas (native) + tokens + total in USD */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Gas (native)</p>
          <p className="text-base font-bold text-text-primary mt-1">{data.nativeUsd !== null ? fmtUsd(data.nativeUsd) : '—'}</p>
          <p className="text-[11px] text-text-muted mt-0.5">{fmtBalance(data.nativeBalance)} {data.nativeSymbol}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Tokens</p>
          <p className="text-base font-bold text-text-primary mt-1">{tokenUsdTotal > 0 ? fmtUsd(tokenUsdTotal) : '—'}</p>
          <p className="text-[11px] text-text-muted mt-0.5">{data.tokens.length} configured</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Total</p>
          <p className="text-base font-bold text-text-primary mt-1">{totalUsd > 0 ? fmtUsd(totalUsd) : '—'}</p>
          <p className="text-[11px] text-text-muted mt-0.5">native + tokens</p>
        </div>
      </div>

      {/* Native balance */}
      <div className="bg-surface border border-border rounded-xl p-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Native balance</p>
        <div className="flex items-center gap-2.5">
          <EntityLogo type="chain" slug={chain} size="md" />
          <div>
            <p className="text-lg font-bold text-text-primary">
              {fmtBalance(data.nativeBalance)} <span className="text-sm font-medium text-text-muted">{data.nativeSymbol}</span>
            </p>
            {data.nativeUsd !== null && <p className="text-xs text-text-muted">{fmtUsd(data.nativeUsd)}</p>}
          </div>
        </div>
        <p className="text-xs text-text-muted mt-2">Used to pay network fees for deliveries and refunds on this chain.</p>
      </div>

      {/* Token balances */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <p className="text-sm font-semibold text-text-primary">Configured tokens</p>
          {tokenUsdTotal > 0 && <span className="text-xs text-text-muted">Total {fmtUsd(tokenUsdTotal)}</span>}
        </div>
        {data.tokens.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-text-muted">
            No non-native tokens are configured for this chain. Add USDT/USDC under this chain in
            {' '}<button onClick={() => router.push('/admin/gas/chains')} className="text-primary underline">Gas Chains</button>.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-alt border-b border-border">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium text-text-muted">Token</th>
                <th className="text-right px-5 py-2.5 font-medium text-text-muted">Balance</th>
                <th className="text-right px-5 py-2.5 font-medium text-text-muted">USD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.tokens.map((t) => (
                <tr key={t.symbol + (t.contractAddress ?? '')}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <TokenChainLogo tokenSymbol={t.symbol} chain={chain} size="sm" />
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{t.symbol}</p>
                        {t.name && <p className="text-[11px] text-text-muted truncate max-w-[220px]">{t.name}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {t.error
                      ? <span title={t.error} className="inline-flex flex-col items-end gap-0.5">
                          <Badge variant="danger" size="sm">read failed</Badge>
                          <span className="text-[10px] text-danger/80 max-w-[280px] truncate text-right">{t.error}</span>
                        </span>
                      : <span className="font-semibold text-text-primary">{fmtBalance(t.balance)} {t.symbol}</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-text-muted">{t.usd !== null ? fmtUsd(t.usd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="px-5 py-3 border-t border-border bg-surface-alt">
          <p className="text-xs text-text-muted">
            Balances are read live from the chain. Tokens sent to this address from anywhere — including external top-ups —
            appear here automatically.
          </p>
        </div>
      </div>
    </div>
  )
}
