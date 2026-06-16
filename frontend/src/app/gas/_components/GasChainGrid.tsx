'use client'
import { gasApi } from '@/lib/api'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Fuel } from 'lucide-react'
import { useGasCtx } from './GasContext'
import { ChainLogo, ChainSkeleton, catGradient, CAT_LABELS } from './GasPrimitives'
import { CustomGasRequest } from './CustomGasRequest'

export function GasChainGrid() {
  const {
    chains, chainsLoading, chainsError,
    setChainsError, setChainsLoading, setChains,
    selectedChain, handleSelectChain,
  } = useGasCtx()

  return (
    <div>
      <div className="text-center mb-6">
        <h2 className="text-xl font-bold text-text-primary">Select Blockchain</h2>
        <p className="text-sm text-text-muted mt-1">Choose a blockchain to view gas fee and create gas orders</p>
      </div>

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

      {!chainsLoading && !chainsError && chains.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {chains.map(chain => {
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
