'use client'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE, PKR_METHOD_META, type PkrMethodKey } from './GasContext'
import { CardHeader, PkrMethodIcon, pkrIsConfigured } from './GasPrimitives'

export function GasPkrMethodStep() {
  const {
    selectedToken, setPhase, pkrMethods, user,
    selectedPkrMethod, setSelectedPkrMethod,
    creatingPkr, pkrError, handleCreatePkrOrder,
    amount, priceUsd, gasValueUsd, platformFeeUsdt,
    usdPkrRate, computedPkr,
  } = useGasCtx()

  if (!selectedToken) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.PAY_METHOD)} title="Pay with PKR" sub="Select your payment method" />

      <div className="space-y-2">
        {(Object.keys(PKR_METHOD_META) as PkrMethodKey[]).map(key => {
          const meta       = PKR_METHOD_META[key]
          const sel        = selectedPkrMethod === key
          const configured = pkrIsConfigured(key, pkrMethods)
          return (
            <button
              key={key}
              onClick={() => configured && setSelectedPkrMethod(key)}
              disabled={!configured}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                !configured ? 'opacity-40 cursor-not-allowed border-border bg-surface-alt'
                : sel ? 'border-primary bg-primary/5'
                : 'border-border bg-surface hover:border-primary/20'
              }`}
            >
              <PkrMethodIcon methodKey={key} pkrMethods={pkrMethods} sizeCls="w-12 h-12" />
              <div className="flex-1">
                <p className="text-sm font-bold text-text-primary">{meta.label}</p>
                <p className="text-xs text-text-muted">{configured ? meta.desc : 'Currently unavailable'}</p>
              </div>
              {sel && (
                <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                </div>
              )}
            </button>
          )
        })}
      </div>

      {selectedPkrMethod && (
        <div className="bg-surface-alt rounded-xl p-4 space-y-2.5 text-sm">
          <p className="text-xs font-bold text-text-muted uppercase tracking-wide">Payment Breakdown</p>
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">Gas Ordered</span>
              <span className="font-semibold">{amount} {selectedToken.symbol}</span>
            </div>
            {priceUsd > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-text-muted">Market Price</span>
                <span className="font-semibold">${priceUsd.toFixed(4)} / {selectedToken.symbol}</span>
              </div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">Token Value</span>
              <span className="font-semibold">${gasValueUsd.toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-muted">Platform Fee</span>
              <span className="font-semibold">${platformFeeUsdt.toFixed(2)} USDT</span>
            </div>
            {usdPkrRate > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-text-muted">Exchange Rate</span>
                <span className="font-semibold">1 USDT ≈ PKR {usdPkrRate.toFixed(0)}</span>
              </div>
            )}
            <div className="flex justify-between pt-2 border-t border-border">
              <span className="font-bold text-text-primary">Total Payable in PKR</span>
              <span className="font-bold text-green-700 dark:text-green-300 text-base">PKR {computedPkr.toFixed(0)}</span>
            </div>
          </div>
        </div>
      )}

      {pkrError && <p className="text-sm text-red-500 bg-red-500/10 rounded-xl px-3 py-2">{pkrError}</p>}

      {!user && selectedPkrMethod && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
          You must be logged in to pay with PKR.{' '}
          <Link href="/login" className="font-bold underline">Log in →</Link>
        </div>
      )}

      <Button
        className="w-full"
        disabled={!selectedPkrMethod || !user || creatingPkr}
        loading={creatingPkr}
        onClick={handleCreatePkrOrder}
      >
        {creatingPkr ? 'Creating Order...' : `Pay PKR ${computedPkr.toFixed(0)}`}
      </Button>
    </div>
  )
}
