'use client'
import { useEffect, useState } from 'react'
import { gasApi } from '@/lib/api'
import type { GasRecentPurchase } from '@/lib/api'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Fuel, Search, X } from 'lucide-react'
import { useGasCtx } from './GasContext'
import { ChainLogo, ChainSkeleton, catGradient, CAT_LABELS } from './GasPrimitives'
import { CustomGasRequest } from './CustomGasRequest'
import { TickerBanner } from '@/components/shared/TickerBanner'
import { gasTickerItem } from '@/components/shared/tickerItems'
import { usePolling } from '@/hooks/usePolling'

export function GasChainGrid() {
  const {
    chains, chainsLoading, chainsError,
    setChainsError, setChainsLoading, setChains,
    selectedChain, handleSelectChain,
  } = useGasCtx()

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visibleChains = q ? chains.filter((c) => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)) : chains
  const [recentPurchases, setRecentPurchases] = useState<GasRecentPurchase[]>([])
  const fetchRecentPurchases = async () => {
    try {
      setRecentPurchases(await gasApi.getRecentPurchases())
    } catch { /* social-proof ticker is non-critical — suppress */ }
  }
  useEffect(() => { fetchRecentPurchases() }, [])
  usePolling(fetchRecentPurchases, 60_000, true)

  return (
    <div>
      <div className="text-center mb-6">
        <div className="flex items-center justify-center gap-2">
          <h2 className="text-xl font-bold text-text-primary">Select Blockchain</h2>
          <button
            type="button"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label="Search blockchains"
            aria-expanded={searchOpen}
            className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg border transition-colors ${
              searchOpen || q ? 'border-primary text-primary bg-primary/5' : 'border-border text-text-muted hover:text-text-primary'
            }`}
          >
            <Search size={16} />
          </button>
        </div>
        <p className="text-sm text-text-muted mt-1">Choose a blockchain to view gas fee and create gas orders</p>
      </div>

      {(searchOpen || q) && (
        <div className="relative mb-4 max-w-md mx-auto">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search blockchain by name or symbol…"
            className="w-full border border-border rounded-lg pl-9 pr-9 py-2.5 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setSearchOpen(false) }}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}

      {/* Recent purchases ticker */}
      <TickerBanner
        label="Recent Purchases"
        items={recentPurchases.map((p) => ({ key: p.id, node: gasTickerItem(p) }))}
      />

      {chainsLoading && <ChainSkeleton />}
      {chainsError && (
        <ErrorState
          title={chainsError}
          onRetry={() => {
            setChainsError('')
            setChainsLoading(true)
            gasApi.getChains()
              .then(({ chains: c }) => setChains(c))
              .catch((e: Error) => setChainsError(e.message))
              .finally(() => setChainsLoading(false))
          }}
        />
      )}

      {!chainsLoading && !chainsError && chains.length === 0 && (
        <div className="text-center py-16 px-4">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <Fuel size={32} className="text-amber-500" />
            </div>
          </div>
          <h3 className="text-lg font-semibold text-text-primary mb-2">⛽ Gas Fee Service Unavailable</h3>
          <p className="text-sm text-text-muted max-w-sm mx-auto">
            No blockchain networks are currently active. Check back soon — we&apos;re working on expanding coverage.
          </p>
        </div>
      )}

      {!chainsLoading && !chainsError && chains.length > 0 && visibleChains.length === 0 && (
        <p className="text-center text-sm text-text-muted py-10">No blockchain matches &ldquo;{query.trim()}&rdquo;.</p>
      )}

      {!chainsLoading && !chainsError && visibleChains.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {visibleChains.map(chain => {
            const inactive = !chain.isActive || !chain.orderable
            return (
              <button
                key={chain.id}
                onClick={() => handleSelectChain(chain)}
                disabled={inactive}
                className={`group flex flex-col items-center justify-center gap-2.5 p-4 rounded-xl border-2 text-center transition-all duration-200 h-full min-h-[150px] ${
                  inactive
                    ? 'opacity-50 cursor-not-allowed border-border bg-surface'
                    : selectedChain?.id === chain.id
                    ? 'border-primary bg-primary/5 shadow-md shadow-primary/10'
                    : 'border-border bg-surface hover:border-primary/30 hover:shadow-md hover:scale-[1.03]'
                }`}
              >
                <div className={!inactive ? 'group-hover:scale-110 transition-transform' : ''}>
                  <ChainLogo chain={chain} />
                </div>
                <div className="min-w-0 w-full">
                  <p className="text-xs font-bold text-text-primary truncate">{chain.name}</p>
                  <p className="text-xs text-text-muted font-medium">{chain.symbol}</p>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gradient-to-r ${catGradient(chain.category)} text-white`}>
                  {CAT_LABELS[chain.category] ?? chain.category}
                </span>
                {chain.badge?.color === 'green'
                  ? <Badge variant="success" size="sm">{chain.badge.label}</Badge>
                  : chain.badge?.color === 'yellow'
                  ? <Badge variant="warning" size="sm">{chain.badge.label}</Badge>
                  : chain.badge
                  ? <Badge variant="default" size="sm">{chain.badge.label}</Badge>
                  : chain.isAvailable
                  ? <Badge variant="success" size="sm">Active</Badge>
                  : <Badge variant="default" size="sm">Setup</Badge>
                }
              </button>
            )
          })}
        </div>
      )}

      <CustomGasRequest />
    </div>
  )
}
