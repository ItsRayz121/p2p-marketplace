'use client'
import { LoadingState } from '@/components/ui/LoadingState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useGasCtx, PHASE } from './GasContext'
import { ChainLogo, CardHeader } from './GasPrimitives'
import { GasPromoField, GasAffiliateApplied } from './GasPromo'

export function GasPaymentChoice() {
  const {
    selectedChain, selectedToken, setPhase,
    methodsLoading, computedUsd, promoApplied, effectiveUsd, effectivePkr, affiliateDiscountUsd,
  } = useGasCtx()
  const discounted = !!promoApplied || affiliateDiscountUsd > 0

  if (!selectedChain || !selectedToken) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.ADDRESS)} title="Choose How You Want to Pay" sub="Select your preferred payment method" />

      {/* Pills kept on a single line (no wrap) so "≈ PKR …" never drops to its own
          row on mobile. Tightened padding/gap to fit; scrolls if ever too wide. */}
      <div className="flex items-center gap-1.5 text-xs overflow-x-auto -mx-1 px-1">
        <span className="flex items-center gap-1.5 bg-surface-alt rounded-full px-2.5 py-1 whitespace-nowrap flex-shrink-0">
          <ChainLogo chain={selectedChain} sizeCls="w-4 h-4" />
          {selectedToken.symbol} · {selectedChain.networkLabel}
        </span>
        {discounted ? (
          <>
            <span className="text-text-muted line-through flex-shrink-0">${computedUsd.toFixed(2)}</span>
            <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">${effectiveUsd.toFixed(2)} USDT</span>
          </>
        ) : (
          <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">${computedUsd.toFixed(2)} USDT</span>
        )}
        <span className="bg-green-500/15 text-green-700 dark:text-green-300 rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">≈ PKR {effectivePkr.toFixed(0)}</span>
      </div>

      {/* Affiliate auto-discount (if the buyer came via an affiliate link) + promo code. */}
      <GasAffiliateApplied />
      <GasPromoField />

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
