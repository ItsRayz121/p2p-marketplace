'use client'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { TokenLogo, CardHeader } from './GasPrimitives'

export function GasTokenStep() {
  const {
    selectedChain, tokenData, tokensLoading, tokensError,
    selectedToken, setSelectedToken, fetchTokens, setPhase,
  } = useGasCtx()

  if (!selectedChain) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.CHAINS)} title="Select Token" sub={`${selectedChain.name} · ${selectedChain.networkLabel}`} />

      {tokensLoading && <LoadingState message="Loading tokens..." />}
      {tokensError && <ErrorState title={tokensError} onRetry={() => fetchTokens(selectedChain)} />}

      {!tokensLoading && !tokensError && tokenData && (
        <div className="space-y-3">
          {tokenData.tokens.map(t => {
            const sel = selectedToken?.id === t.id
            const inactive = !t.isActive
            const tRaw = t.rawUsdPrice ?? t.priceUsd
            const displayPrice = tRaw > 0 ? `$${tRaw.toFixed(4)}` : t.rateStale ? 'Rate unavailable' : '—'
            const displaySub   = tRaw > 0 ? `per ${t.symbol}` : ''
            return (
              <button
                key={t.id}
                onClick={() => { if (!inactive) setSelectedToken(t) }}
                disabled={inactive}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all duration-200 ${
                  inactive
                    ? 'border-border bg-surface-alt opacity-60 cursor-not-allowed'
                    : sel
                    ? 'border-primary bg-gradient-to-r from-primary/5 to-blue-50 dark:to-blue-950/20'
                    : 'border-border bg-surface-alt hover:border-primary/20'
                }`}
              >
                <TokenLogo token={t} cat={selectedChain.category} sizeCls="w-12 h-12" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-text-primary">{t.name}</p>
                    {inactive && <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-border text-text-muted">Soon</span>}
                    {!inactive && t.rateStale && <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-700">Rate stale</span>}
                  </div>
                  <p className="text-xs text-text-muted">{t.symbol} · {selectedChain.networkLabel}</p>
                </div>
                <div className="text-right">
                  {inactive ? (
                    <p className="text-sm text-text-muted">Coming soon</p>
                  ) : (
                    <>
                      <p className={`text-sm font-bold ${t.rateStale ? 'text-yellow-600' : 'text-text-primary'}`}>{displayPrice}</p>
                      <p className="text-xs text-text-muted">{displaySub || `per ${t.symbol}`}</p>
                    </>
                  )}
                </div>
                {!inactive && sel && (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      <Button className="w-full" disabled={!selectedToken} onClick={() => setPhase(PHASE.AMOUNT)}>
        Next <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </Button>
    </div>
  )
}
