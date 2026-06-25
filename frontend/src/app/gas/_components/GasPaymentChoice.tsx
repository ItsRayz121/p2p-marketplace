'use client'
import { LoadingState } from '@/components/ui/LoadingState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useGasCtx, PHASE } from './GasContext'
import { ChainLogo, CardHeader } from './GasPrimitives'

export function GasPaymentChoice() {
  const {
    selectedChain, selectedToken, setPhase,
    methodsLoading, computedUsd, usdPkrRate,
    promoEnabled, promoCode, setPromoCode, promoApplied, promoError, promoChecking, applyPromo, clearPromo,
  } = useGasCtx()

  if (!selectedChain || !selectedToken) return null

  // Promo discount only ever reduces the platform fee — the displayed total drops by
  // the discount, never below the base gas cost (enforced server-side).
  const effectiveUsd = promoApplied ? Math.max(0, computedUsd - promoApplied.discountUsdt) : computedUsd
  const effectivePkr = effectiveUsd * usdPkrRate

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.ADDRESS)} title="Choose How You Want to Pay" sub="Select your preferred payment method" />

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="flex items-center gap-1.5 bg-surface-alt rounded-full px-3 py-1">
          <ChainLogo chain={selectedChain} sizeCls="w-4 h-4" />
          {selectedToken.symbol} · {selectedChain.networkLabel}
        </span>
        {promoApplied ? (
          <>
            <span className="text-text-muted line-through">${computedUsd.toFixed(2)}</span>
            <span className="bg-primary/10 text-primary rounded-full px-3 py-1 font-bold">${effectiveUsd.toFixed(2)} USDT</span>
          </>
        ) : (
          <span className="bg-primary/10 text-primary rounded-full px-3 py-1 font-bold">${computedUsd.toFixed(2)} USDT</span>
        )}
        <span className="bg-green-500/15 text-green-700 dark:text-green-300 rounded-full px-3 py-1 font-bold">≈ PKR {effectivePkr.toFixed(0)}</span>
      </div>

      {/* Promo code — only rendered when the feature is live (flag-gated). The message
          is scoped to the applied code only; there is no global discount banner. */}
      {promoEnabled && (
        <div className="rounded-xl border border-border bg-surface-alt/50 p-3.5">
          {!promoApplied ? (
            <>
              <p className="text-xs font-semibold text-text-primary mb-2">Have a promo code?</p>
              <div className="flex gap-2">
                <input
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPromo() } }}
                  placeholder="Enter code"
                  maxLength={40}
                  className="flex-1 min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm uppercase tracking-wide focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <button
                  onClick={applyPromo}
                  disabled={promoChecking || !promoCode.trim()}
                  className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
                >
                  {promoChecking ? 'Checking…' : 'Apply'}
                </button>
              </div>
              {promoError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{promoError}</p>}
            </>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-green-700 dark:text-green-300">
                  Code {promoApplied.code} applied — {promoApplied.discountPct}% off the platform fee
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  You save ${promoApplied.discountUsdt.toFixed(2)}
                  {promoApplied.slotsLeft != null && promoApplied.slotsLeft > 0
                    ? ` · ${promoApplied.slotsLeft} ${promoApplied.slotsLeft === 1 ? 'slot' : 'slots'} left at this rate`
                    : ''}
                </p>
              </div>
              <button onClick={clearPromo} className="shrink-0 text-xs font-semibold text-text-muted hover:text-text-primary underline">
                Remove
              </button>
            </div>
          )}
        </div>
      )}

      {methodsLoading && <LoadingState message="Loading payment options..." />}

      {!methodsLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={() => setPhase(PHASE.PKR_METHOD)}
            className="flex flex-col gap-3 p-5 rounded-xl border-2 border-border bg-surface hover:border-green-500/50 hover:shadow-card transition-all text-left group"
          >
            <div className="flex items-center justify-between">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-white font-bold text-2xl shadow-card ring-1 ring-black/5">₨</div>
              <span className="text-xs bg-green-500/15 text-green-700 dark:text-green-300 font-semibold px-2.5 py-1 rounded-full">Easy & Fast</span>
            </div>
            <div>
              <p className="text-sm font-bold text-text-primary mb-0.5">Pay with PKR</p>
              <p className="text-xs text-text-muted">Bank Transfer · Easypaisa · JazzCash</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              No crypto needed
            </div>
          </button>

          <button
            onClick={() => setPhase(PHASE.CRYPTO_NETWORK)}
            className="flex flex-col gap-3 p-5 rounded-xl border-2 border-border bg-surface hover:border-blue-500/50 hover:shadow-card transition-all text-left group"
          >
            <div className="flex items-center justify-between">
              <EntityLogo type="token" slug="USDT" size="2xl" className="w-12 h-12 shadow-card" />
              <span className="text-xs bg-blue-500/15 text-blue-700 dark:text-blue-300 font-semibold px-2.5 py-1 rounded-full">Low Fees</span>
            </div>
            <div>
              <p className="text-sm font-bold text-text-primary mb-0.5">Pay with Crypto</p>
              <p className="text-xs text-text-muted">USDT BEP20 · USDT Aptos</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              Instant payment detection
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
