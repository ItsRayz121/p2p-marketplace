'use client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useGasCtx, PHASE } from './GasContext'
import { CardHeader } from './GasPrimitives'
import { supportMailto } from '@/lib/contact'

export function GasAmountStep() {
  const {
    selectedChain, selectedToken, setPhase,
    amount, setAmount, amountError, setAmountError,
    validateAmountField,
    priceUsd, pricePkr, gasValueUsd, usdPkrRate,
    amountNum, maxUsd, minAmount, usdExceeded,
  } = useGasCtx()

  if (!selectedChain || !selectedToken) return null

  return (
    <div className="p-5 space-y-4">
      <CardHeader onBack={() => setPhase(PHASE.TOKEN)} title="Choose Amount" />

      <div className="flex items-center justify-between bg-surface-alt rounded-xl px-4 py-3 text-sm">
        <div>
          <span className="text-text-muted">Market Price</span>
          <p className="text-xs text-text-muted mt-0.5">1 {selectedToken.symbol}</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-text-primary">${priceUsd.toFixed(4)}</p>
          <p className="text-xs text-text-muted">≈ PKR {pricePkr.toFixed(0)}</p>
        </div>
      </div>

      {/* Preset chips */}
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Quick Select</p>
        <div className="flex flex-wrap gap-2">
          {selectedToken.presetAmounts.map(preset => {
            const usdVal = preset * priceUsd
            const tooHigh = usdVal > maxUsd
            const active  = amount === String(preset) && !tooHigh
            return (
              <button
                key={preset}
                onClick={() => {
                  if (!tooHigh) {
                    setAmount(String(preset))
                    if (usdVal > maxUsd) setAmountError(`Exceeds $${maxUsd} limit`)
                    else setAmountError('')
                  }
                }}
                disabled={tooHigh}
                className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all flex flex-col items-center ${
                  active    ? 'border-primary bg-primary text-white shadow-card'
                  : tooHigh ? 'border-border text-text-disabled bg-surface-alt cursor-not-allowed'
                  :           'border-border bg-surface text-text-secondary hover:border-primary/30'
                }`}
              >
                <span>{preset} {selectedToken.symbol}</span>
                {priceUsd > 0 && (
                  <span className={`text-[10px] font-medium mt-0.5 ${active ? 'text-white/70' : tooHigh ? 'text-text-disabled' : 'text-text-muted'}`}>
                    ≈ ${usdVal.toFixed(2)}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom input */}
      <div>
        <label className="block text-xs font-semibold text-text-secondary mb-1.5">Custom Amount ({selectedToken.symbol})</label>
        <Input
          type="number"
          placeholder={`Min ${minAmount}`}
          value={amount}
          onChange={e => { const v = e.target.value; setAmount(v); if (v) validateAmountField(v); else setAmountError('') }}
          onBlur={() => { if (amount) validateAmountField(amount) }}
          min={minAmount}
          step="any"
        />
        {amountError && <p className="text-xs text-red-500 mt-1">{amountError}</p>}
        {amountNum > 0 && !amountError && (
          <div className={`text-xs mt-1.5 space-y-0.5 ${usdExceeded ? 'text-red-500' : 'text-text-muted'}`}>
            <div className="flex gap-2">
              <span>≈ <span className="font-semibold">${gasValueUsd.toFixed(4)}</span> market value</span>
              <span className="text-text-muted">≈ PKR {(gasValueUsd * usdPkrRate).toFixed(0)}</span>
            </div>
            {usdExceeded && <span className="font-semibold">— exceeds ${maxUsd} limit</span>}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 bg-blue-50 dark:bg-blue-950/40 rounded-xl px-3 py-2.5 text-xs text-blue-600 dark:text-blue-400">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          Max order value: <span className="font-bold ml-1">${maxUsd} USDT</span> per transaction
        </div>
        <a
          href={supportMailto('Gas Fee Large Order Request')}
          title={`Need more than $${maxUsd}? Email us and we'll help you with a larger gas order.`}
          className="underline hover:no-underline whitespace-nowrap flex-shrink-0 font-semibold"
        >
          Request higher limit
        </a>
      </div>

      <Button
        className="w-full"
        disabled={!amount || !!amountError || usdExceeded}
        onClick={() => { if (validateAmountField(amount)) setPhase(PHASE.ADDRESS) }}
      >
        Continue <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
      </Button>
    </div>
  )
}
