'use client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader, validateAddress, ChainLogo, TokenLogo } from './GasPrimitives'

export function GasAddressStep() {
  const {
    selectedChain, selectedToken, setPhase,
    address, setAddress, addressError,
    validateAddressField, networkFee,
    amount, amountNum, priceUsd, gasValueUsd, platformFeeUsdt,
    usdPkrRate, computedUsd, computedPkr,
  } = useGasCtx()

  if (!selectedChain || !selectedToken) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.AMOUNT)} title={`Enter ${selectedChain.networkLabel} Address`} />

      <p className="text-xs text-text-muted">The wallet address that needs {selectedToken.symbol} for gas.</p>

      <div>
        <label className="block text-xs font-semibold text-text-secondary mb-1.5">{selectedChain.name} Wallet Address</label>
        <Input
          placeholder={selectedChain.addressType === 'TRC20' ? 'T... (34 characters)' : selectedChain.addressType === 'EVM' ? '0x... (42 characters)' : 'Enter wallet address'}
          value={address}
          onChange={e => { setAddress(e.target.value); if (addressError) validateAddressField(e.target.value) }}
          onBlur={() => validateAddressField(address)}
        />
        {addressError && <p className="text-xs text-red-500 mt-1">{addressError}</p>}
        {address && !addressError && validateAddress(address, selectedChain.addressType) && (
          <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            Valid {selectedChain.networkLabel} address
          </p>
        )}
      </div>

      {/* Order Summary */}
      <div className="bg-surface-alt rounded-xl p-4 space-y-2 text-xs">
        <p className="font-bold text-text-muted uppercase tracking-wide mb-1">Order Summary</p>
        <div className="flex justify-between items-center"><span className="text-text-muted">Network</span><span className="font-semibold text-text-primary flex items-center gap-1.5"><ChainLogo chain={selectedChain} sizeCls="w-4 h-4" />{selectedChain.name}</span></div>
        <div className="flex justify-between items-center"><span className="text-text-muted">Token</span><span className="font-semibold text-text-primary flex items-center gap-1.5"><TokenLogo token={selectedToken} cat={selectedChain.category} chainLogoUrl={selectedChain.logoUrl} sizeCls="w-4 h-4" />{selectedToken.symbol}</span></div>
        <div className="flex justify-between">
          <span className="text-text-muted">Amount</span>
          <span className="font-semibold text-text-primary">
            {amount} {selectedToken.symbol}
            {priceUsd > 0 && amountNum > 0 && <span className="text-text-muted font-normal"> (≈ ${gasValueUsd.toFixed(2)})</span>}
          </span>
        </div>
        {priceUsd > 0 && amountNum > 0 && (
          <div className="flex justify-between">
            <span className="text-text-muted">Market Price</span>
            <span className="font-semibold text-text-primary">${priceUsd.toFixed(4)} / {selectedToken.symbol}</span>
          </div>
        )}
        {priceUsd > 0 && amountNum > 0 && (
          <div className="flex justify-between">
            <span className="text-text-muted">Token Value</span>
            <span className="font-semibold text-text-primary">${gasValueUsd.toFixed(2)} USDT</span>
          </div>
        )}
        <div className="pt-1.5 border-t border-border space-y-1.5">
          <p className="text-text-muted font-semibold uppercase tracking-wide" style={{ fontSize: '0.65rem' }}>Platform charges</p>
          {networkFee?.supported && (networkFee.estimatedFeeNative ?? 0) > 0 ? (
            <div className="flex justify-between items-start gap-2">
              <span className="text-text-secondary font-medium">
                {selectedChain.name} Network Fee
                {networkFee.gasPriceGwei != null && <span className="text-text-muted font-normal"> · {networkFee.gasPriceGwei.toFixed(2)} Gwei</span>}
              </span>
              <span className="font-semibold text-text-primary text-right">
                <span className="block">~{(networkFee.estimatedFeeNative ?? 0).toFixed(6)} {networkFee.symbol}</span>
                {networkFee.estimatedFeeUsd != null && (
                  <span className="block text-text-muted font-normal">
                    {networkFee.estimatedFeeUsd < 0.001 ? `≈ $${networkFee.estimatedFeeUsd.toFixed(5)}` : networkFee.estimatedFeeUsd < 0.01 ? `≈ $${networkFee.estimatedFeeUsd.toFixed(4)}` : `≈ $${networkFee.estimatedFeeUsd.toFixed(3)}`}
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex justify-between">
              <span className="text-text-secondary font-medium">{selectedChain.name} Network Fee</span>
              <span className="text-text-muted italic">included in platform fee</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-text-secondary font-medium">Platform Service Fee</span>
            <span className="font-semibold text-text-primary">${platformFeeUsdt.toFixed(2)} USDT</span>
          </div>
        </div>
        <div className="flex justify-between pt-2 border-t border-border">
          <span className="text-text-secondary font-semibold">You Pay</span>
          <div className="text-right">
            <p className="font-bold text-primary">${computedUsd.toFixed(2)} USDT</p>
            <p className="text-text-muted">≈ PKR {computedPkr.toFixed(0)}</p>
          </div>
        </div>
        {networkFee?.supported && networkFee.estimatedFeeNative != null && amountNum > 0 && networkFee.estimatedFeeNative > 0 && (
          <div className="mt-1 pt-2 border-t border-border">
            <div className="flex items-start gap-1.5 text-text-muted">
              <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <p className="text-text-muted">
                Your {amount} {selectedToken.symbol} covers ~{Math.floor(amountNum / networkFee.estimatedFeeNative).toLocaleString()} {selectedChain.name} transfers
              </p>
            </div>
          </div>
        )}
      </div>

      <Button
        className="w-full"
        disabled={!validateAddress(address, selectedChain.addressType)}
        onClick={() => { if (validateAddressField(address)) setPhase(PHASE.PAY_METHOD) }}
      >
        Proceed to Payment <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </Button>
    </div>
  )
}
