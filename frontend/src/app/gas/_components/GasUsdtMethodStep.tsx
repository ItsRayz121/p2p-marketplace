'use client'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader } from './GasPrimitives'

/**
 * "Pay with USDT" — the second step after the customer picks USDT on the payment
 * choice screen. Blockchain is the recommended (instant, automatic) route;
 * Exchange transfer is a manual-review internal transfer and only shows when at
 * least one receiving exchange account is configured in admin.
 */
export function GasUsdtMethodStep() {
  const {
    selectedToken, setPhase, computedUsd, effectiveUsd, computedPkr, effectivePkr,
    promoApplied, promoDiscountUsd, affiliateDiscountUsd,
    exchangeAccounts, exchangeAccountsLoading,
  } = useGasCtx()

  if (!selectedToken) return null

  const discounted = (!!promoApplied && promoDiscountUsd > 0) || affiliateDiscountUsd > 0
  const exchangeAvailable = (exchangeAccounts?.length ?? 0) > 0
  // exchangeAccounts === null while the list is still loading — keep the card
  // visible but inert so the layout doesn't jump when it arrives.
  const exchangeLoading = exchangeAccounts === null && exchangeAccountsLoading

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.PAY_METHOD)} title="Pay with USDT" sub="Choose how you will send it" />

      <div className="flex items-center gap-1.5 text-xs overflow-x-auto -mx-1 px-1">
        {discounted ? (
          <>
            <span className="text-text-muted line-through flex-shrink-0">${computedUsd.toFixed(2)}</span>
            <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">${effectiveUsd.toFixed(2)} USDT</span>
          </>
        ) : (
          <span className="bg-primary/10 text-primary rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">${computedUsd.toFixed(2)} USDT</span>
        )}
        <span className="bg-green-500/15 text-green-700 dark:text-green-300 rounded-full px-2.5 py-1 font-bold whitespace-nowrap flex-shrink-0">
          ≈ PKR {(discounted ? effectivePkr : computedPkr).toFixed(0)}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          onClick={() => setPhase(PHASE.CRYPTO_NETWORK)}
          className="flex flex-col gap-3 p-5 rounded-xl border-2 border-primary bg-primary/5 hover:shadow-card transition-all text-left"
        >
          <div className="flex items-center justify-between">
            <EntityLogo type="token" slug="USDT" size="2xl" className="w-12 h-12 shadow-card" />
            <span className="text-xs bg-primary/15 text-primary font-semibold px-2.5 py-1 rounded-full">Recommended</span>
          </div>
          <div>
            <p className="text-sm font-bold text-text-primary mb-0.5">Blockchain payment</p>
            <p className="text-xs text-text-muted">USDT BEP20 · USDT Aptos</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            Instant detection, gas sent automatically
          </div>
        </button>

        {(exchangeAvailable || exchangeLoading) && (
          <button
            onClick={() => exchangeAvailable && setPhase(PHASE.EXCHANGE)}
            disabled={!exchangeAvailable}
            className="flex flex-col gap-3 p-5 rounded-xl border-2 border-border bg-surface hover:border-amber-500/50 hover:shadow-card transition-all text-left disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <div className="flex -space-x-2">
                {(exchangeAccounts ?? []).slice(0, 3).map((a) => (
                  <EntityLogo key={a.id} type="exchange" slug={a.exchange} size="lg" className="w-10 h-10 rounded-full ring-2 ring-surface bg-surface" />
                ))}
              </div>
              <span className="text-xs bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold px-2.5 py-1 rounded-full">5–10 min</span>
            </div>
            <div>
              <p className="text-sm font-bold text-text-primary mb-0.5">Exchange transfer</p>
              <p className="text-xs text-text-muted">Send from your exchange account by UID</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              No network fee, checked by our team
            </div>
          </button>
        )}
      </div>

      {exchangeAvailable && (
        <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
          Blockchain payments are confirmed automatically in about a minute. Exchange transfers are checked by a person and can take 5 to 10 minutes, sometimes longer.
        </p>
      )}
    </div>
  )
}
