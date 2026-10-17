'use client'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader, PaymentNetworkLogo } from './GasPrimitives'
import { GasPromoField, GasAffiliateApplied } from './GasPromo'
import { GasFreeCodeField } from './GasFreeCode'

type NetworkKey = 'BEP20' | 'APTOS'

/** Rough sender-side network fee in USD per payment network (what the sender's wallet pays, not a RupChain fee). */
const EST_NETWORK_FEE_USD: Record<NetworkKey, number> = { BEP20: 0.29, APTOS: 0.01 }

function NetworkRow({
  networkKey, logoUrl, title, subtitle, fee, lowest, selected, disabled, soon, onSelect,
}: {
  networkKey: NetworkKey; logoUrl: string | null | undefined; title: string; subtitle: string; fee: number
  lowest: boolean; selected: boolean; disabled?: boolean; soon?: boolean; onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-2xl border-2 p-3.5 text-left transition-colors ${
        disabled ? 'cursor-not-allowed border-border bg-surface-alt opacity-60'
        : selected ? 'border-primary bg-primary/5'
        : 'border-border bg-surface hover:border-primary/30'
      }`}
    >
      <PaymentNetworkLogo networkKey={networkKey} logoUrl={logoUrl} sizeCls="w-11 h-11" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold leading-tight text-text-primary">{title}</p>
        <p className="truncate text-xs text-text-muted">{subtitle}</p>
        {soon ? (
          <p className="mt-0.5 text-xs text-text-muted">Coming soon</p>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="whitespace-nowrap text-xs text-text-secondary" title="What your wallet or exchange charges to send the payment. It is not paid to RupChain.">
              Est. network fee: ~ ${fee.toFixed(2)}
            </span>
            {lowest && <span className="whitespace-nowrap rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">Lowest fee</span>}
          </div>
        )}
      </div>
      <span
        aria-hidden
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-primary' : 'border-border'}`}
      >
        {selected && <span className="h-3 w-3 rounded-full bg-primary" />}
      </span>
    </button>
  )
}

export function GasCryptoNetworkStep() {
  const {
    setPhase, cryptoMethods,
    selectedCryptoNetwork, setSelectedCryptoNetwork,
    creatingCrypto, cryptoError, handleCreateCryptoOrder,
    computedUsd, effectiveUsd, promoApplied, promoDiscountUsd, affiliateDiscountUsd,
  } = useGasCtx()
  const discounted = (!!promoApplied && promoDiscountUsd > 0) || affiliateDiscountUsd > 0

  const bepShown = cryptoMethods?.bep20?.enabled !== false
  const bepConfigured = !!cryptoMethods?.bep20?.address
  const aptosShown = cryptoMethods?.aptos?.enabled !== false
  // "Lowest fee" is only meaningful between networks that can actually be chosen right now.
  const selectable = [bepShown && bepConfigured ? 'BEP20' : null, aptosShown ? 'APTOS' : null].filter((k): k is NetworkKey => k !== null)
  const lowestKey = selectable.length > 1 ? selectable.reduce((a, b) => (EST_NETWORK_FEE_USD[a] <= EST_NETWORK_FEE_USD[b] ? a : b)) : null

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <CardHeader onBack={() => setPhase(PHASE.USDT_METHOD)} title="Select Payment Network" sub="Choose a network to send your payment" />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-text-muted">Total due</span>
        {discounted && <span className="text-text-muted line-through">{computedUsd.toFixed(2)} USDT</span>}
        <span className="rounded-full bg-primary/10 px-3 py-1 font-bold text-primary">{(discounted ? effectiveUsd : computedUsd).toFixed(2)} USDT</span>
      </div>

      {/* Affiliate auto-discount + promo code + KOL free-gas code — all apply to the
          order created below (free code is mutually exclusive with the promo code). */}
      <GasAffiliateApplied />
      <GasFreeCodeField />
      <GasPromoField />

      <div className="space-y-2.5" role="radiogroup" aria-label="Payment network">
        {bepShown && (
          <NetworkRow
            networkKey="BEP20" logoUrl={cryptoMethods?.bep20?.logoUrl}
            title="USDT · BEP20" subtitle="BNB Smart Chain" fee={EST_NETWORK_FEE_USD.BEP20}
            lowest={lowestKey === 'BEP20'} selected={selectedCryptoNetwork === 'BEP20'}
            disabled={!bepConfigured} soon={!bepConfigured}
            onSelect={() => setSelectedCryptoNetwork('BEP20')}
          />
        )}
        {aptosShown && (
          <NetworkRow
            networkKey="APTOS" logoUrl={cryptoMethods?.aptos?.logoUrl}
            title="USDT · Aptos" subtitle="Aptos network" fee={EST_NETWORK_FEE_USD.APTOS}
            lowest={lowestKey === 'APTOS'} selected={selectedCryptoNetwork === 'APTOS'}
            onSelect={() => setSelectedCryptoNetwork('APTOS')}
          />
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-alt p-3">
        <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.6-4.1A12 12 0 0112 2.9 12 12 0 016.4 5.9 12 12 0 004 12c0 5.2 3.3 9.6 8 11 4.7-1.4 8-5.8 8-11 0-2.4-.8-4.6-2.4-6.1z" /></svg>
        <div>
          <p className="text-sm font-semibold text-text-primary">Send only USDT on the selected network</p>
          <p className="text-xs text-text-muted">Sending any other asset may result in permanent loss.</p>
        </div>
      </div>

      {cryptoError && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{cryptoError}</p>}

      <Button
        className="w-full"
        size="lg"
        disabled={!selectedCryptoNetwork || creatingCrypto}
        loading={creatingCrypto}
        onClick={handleCreateCryptoOrder}
      >
        {creatingCrypto ? 'Creating Order...' : 'Continue'}
        {!creatingCrypto && <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
      </Button>
    </div>
  )
}
