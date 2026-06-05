'use client'
import { Button } from '@/components/ui/Button'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader, PaymentNetworkLogo } from './GasPrimitives'

export function GasCryptoNetworkStep() {
  const {
    setPhase, cryptoMethods,
    selectedCryptoNetwork, setSelectedCryptoNetwork,
    creatingCrypto, cryptoError, handleCreateCryptoOrder,
  } = useGasCtx()

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.PAY_METHOD)} title="Select Payment Network" sub="Choose a network to send your payment" />

      <div className="space-y-3">
        {/* BEP20 */}
        {(() => {
          const bepConfigured = !!cryptoMethods?.bep20?.address
          const bepAddr       = cryptoMethods?.bep20?.address
          return (
            <button
              onClick={() => bepConfigured && setSelectedCryptoNetwork('BEP20')}
              disabled={!bepConfigured}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                !bepConfigured ? 'opacity-50 cursor-not-allowed border-border bg-surface-alt'
                : selectedCryptoNetwork === 'BEP20' ? 'border-primary bg-primary/5'
                : 'border-border bg-surface hover:border-primary/20'
              }`}
            >
              <PaymentNetworkLogo networkKey="BEP20" logoUrl={cryptoMethods?.bep20?.logoUrl} />
              <div className="flex-1">
                <p className="text-sm font-bold text-text-primary">USDT BEP20</p>
                <p className="text-xs text-text-muted">
                  {bepConfigured ? 'BNB Smart Chain · est. ~$0.29 network fee' : 'Coming soon — not yet configured'}
                </p>
                {bepAddr && <p className="text-xs font-mono text-text-muted mt-0.5">{bepAddr.slice(0, 8)}...{bepAddr.slice(-6)}</p>}
              </div>
              {bepConfigured
                ? selectedCryptoNetwork === 'BEP20'
                  ? <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                  : <span className="text-xs text-text-muted border border-border rounded-full px-2 py-0.5 flex-shrink-0">Select</span>
                : <span className="text-xs bg-surface-alt text-text-muted font-semibold px-2 py-0.5 rounded-full flex-shrink-0">Soon</span>
              }
            </button>
          )
        })()}

        {/* Aptos */}
        {(() => {
          const aptosAddr = cryptoMethods?.aptos?.address
          return (
            <button
              onClick={() => setSelectedCryptoNetwork('APTOS')}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                selectedCryptoNetwork === 'APTOS' ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:border-primary/20'
              }`}
            >
              <PaymentNetworkLogo networkKey="APTOS" logoUrl={cryptoMethods?.aptos?.logoUrl} />
              <div className="flex-1">
                <p className="text-sm font-bold text-text-primary">USDT Aptos</p>
                <p className="text-xs text-text-muted">Aptos Network · ~$0.01 network fee</p>
                {aptosAddr && <p className="text-xs font-mono text-text-muted mt-0.5">{aptosAddr.slice(0, 8)}...{aptosAddr.slice(-6)}</p>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Lowest Fee</span>
                {selectedCryptoNetwork === 'APTOS'
                  ? <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                  : <span className="text-xs text-text-muted border border-border rounded-full px-2 py-0.5">Select</span>
                }
              </div>
            </button>
          )
        })()}
      </div>

      {cryptoError && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{cryptoError}</p>}

      <Button
        className="w-full"
        disabled={!selectedCryptoNetwork || creatingCrypto}
        loading={creatingCrypto}
        onClick={handleCreateCryptoOrder}
      >
        {creatingCrypto ? 'Creating Order...' : 'Continue'}
        {!creatingCrypto && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
      </Button>
    </div>
  )
}
