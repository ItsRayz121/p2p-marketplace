'use client'
import { useState, useEffect } from 'react'
import { adminApi } from '@/lib/api'

// Two-way native ⇆ USDT amount field for admin gas tools (free-gas + gas giveaways).
// The native amount is the source of truth (owned by the parent form). Editing the
// USDT box converts back to native at the live rate, so an admin can size a prize by
// dollar value and never fat-finger a huge native amount. Falls back to native-only
// when no live price is available.
export function GasAmountConverter({
  value,
  onChange,
  priceSymbol,
  symbol,
  label = 'Amount',
  invalid,
  hint,
  placeholder = '0.01',
  onUsdValueChange,
}: {
  value: string
  onChange: (native: string) => void
  priceSymbol?: string | null
  symbol?: string | null
  label?: string
  invalid?: boolean
  hint?: React.ReactNode
  placeholder?: string
  /** Fires with the live per-unit USD value (null while no price/amount) so a parent can derive other fields from it. */
  onUsdValueChange?: (usd: number | null) => void
}) {
  const [usdPrice, setUsdPrice] = useState<number | null>(null)
  const [usdText, setUsdText] = useState('')
  const [usdFocused, setUsdFocused] = useState(false)

  // Live USD price for this token's price symbol (e.g. BNB, ETH, TRX; a stablecoin ≈ 1).
  useEffect(() => {
    if (!priceSymbol) { setUsdPrice(null); return }
    let cancelled = false
    adminApi.getGasNativeRate(priceSymbol)
      .then((r) => { if (!cancelled) setUsdPrice(r.usdPrice > 0 ? r.usdPrice : null) })
      .catch(() => { if (!cancelled) setUsdPrice(null) })
    return () => { cancelled = true }
  }, [priceSymbol])

  const nativeNum = parseFloat(value)

  // Mirror the USDT box from the native amount unless the user is typing in it.
  useEffect(() => {
    if (usdFocused) return
    if (usdPrice && nativeNum > 0) {
      const usd = nativeNum * usdPrice
      setUsdText(usd < 1 ? usd.toFixed(4) : usd.toFixed(2))
    } else if (!value) {
      setUsdText('')
    }
  }, [value, usdPrice, usdFocused, nativeNum])

  useEffect(() => {
    onUsdValueChange?.(usdPrice && nativeNum > 0 ? nativeNum * usdPrice : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usdPrice, nativeNum])

  function onUsdChange(v: string) {
    setUsdText(v)
    const usd = parseFloat(v)
    if (usdPrice && usd > 0) {
      const nat = usd / usdPrice
      onChange(String(Number(nat.toFixed(8))))
    } else if (!v.trim()) {
      onChange('')
    }
  }

  const nativeCls = `mt-1 w-full rounded-lg border bg-surface-alt px-3 py-2 text-sm ${invalid ? 'border-danger' : 'border-border'}`

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs font-semibold text-text-primary">
          {label} ({symbol || 'native'})
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            inputMode="decimal"
            className={nativeCls}
          />
        </label>
        <label className="block text-xs font-semibold text-text-primary">
          ≈ USDT value
          <input
            value={usdText}
            onChange={(e) => onUsdChange(e.target.value)}
            onFocus={() => setUsdFocused(true)}
            onBlur={() => setUsdFocused(false)}
            placeholder={usdPrice ? '0.00' : '—'}
            inputMode="decimal"
            disabled={!usdPrice}
            className="mt-1 w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
      </div>
      {hint && <span className="mt-1 block text-[11px] font-normal">{hint}</span>}
      {!usdPrice && priceSymbol && (
        <span className="mt-1 block text-[11px] text-text-muted">Live price unavailable — enter the native amount directly.</span>
      )}
    </div>
  )
}
