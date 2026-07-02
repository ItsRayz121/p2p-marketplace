'use client'
import { useState, useMemo } from 'react'
import { X } from 'lucide-react'

// Assistive native ⇆ USDT ⇆ PKR converter for the gas purchase step. Locked to the
// token being bought and driven by the SAME rates the order uses (priceUsd = USD per
// token, pkrPerUsd = PKR per USD), so what the user sees here matches checkout.
// Purely a helper — "Use this amount" fills the real Custom Amount field, which still
// runs the normal validation. Does not itself place an order.
type Unit = 'NATIVE' | 'USDT' | 'PKR'

function fmt(n: number, max: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

export function GasCalcPopup({
  symbol, priceUsd, pkrPerUsd, onUse, onClose,
}: {
  symbol: string
  priceUsd: number
  pkrPerUsd: number
  onUse: (native: string) => void
  onClose: () => void
}) {
  const [unit, setUnit] = useState<Unit>('NATIVE')
  const [amount, setAmount] = useState('')

  const pkrPerToken = priceUsd * pkrPerUsd
  const hasRate = priceUsd > 0

  const out = useMemo(() => {
    const n = parseFloat(amount)
    if (!hasRate || !(n >= 0) || amount.trim() === '') return null
    let native: number
    if (unit === 'NATIVE') native = n
    else if (unit === 'USDT') native = n / priceUsd
    else native = pkrPerToken > 0 ? n / pkrPerToken : 0
    return { native, usd: native * priceUsd, pkr: native * pkrPerToken }
  }, [amount, unit, priceUsd, pkrPerToken, hasRate])

  const units: { key: Unit; label: string }[] = [
    { key: 'NATIVE', label: symbol },
    { key: 'USDT', label: 'USDT' },
    { key: 'PKR', label: 'PKR' },
  ]

  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-surface border border-border shadow-xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-text-primary">Amount calculator</h2>
            <p className="text-xs text-text-muted">Estimate {symbol} ⇆ USDT ⇆ PKR</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-muted" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        {!hasRate ? (
          <p className="text-sm text-text-muted text-center py-4">Live price unavailable right now.</p>
        ) : (
          <>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-text-muted">You enter</label>
                <div className="inline-flex rounded-lg bg-surface-alt border border-border p-0.5">
                  {units.map((u) => (
                    <button
                      key={u.key}
                      type="button"
                      onClick={() => setUnit(u.key)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${unit === u.key ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'}`}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={unit === 'NATIVE' ? `e.g. 0.05 ${symbol}` : unit === 'USDT' ? 'e.g. 5' : 'e.g. 1500'}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-surface-alt text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div className="rounded-lg border border-border bg-surface-alt p-3 space-y-2">
              {unit !== 'NATIVE' && (
                <Row label={`≈ ${symbol}`} value={out ? `${fmt(out.native, 8)} ${symbol}` : '—'} />
              )}
              {unit !== 'USDT' && (
                <Row label="≈ USDT" value={out ? `${fmt(out.usd, out.usd < 1 ? 4 : 2)} USDT` : '—'} />
              )}
              {unit !== 'PKR' && (
                <Row label="≈ PKR" value={out ? `PKR ${fmt(out.pkr, 0)}` : '—'} />
              )}
            </div>

            <p className="text-[11px] text-text-muted">
              1 {symbol} ≈ {fmt(priceUsd, priceUsd < 1 ? 4 : 2)} USDT · PKR {fmt(pkrPerToken, 0)}. Final cost includes network + platform fee.
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => { if (out && out.native > 0) { onUse(String(Number(out.native.toFixed(8)))); onClose() } }}
                disabled={!out || out.native <= 0}
                className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                Use {out && out.native > 0 ? `${fmt(out.native, 6)} ${symbol}` : 'this amount'}
              </button>
              <button onClick={onClose} className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-surface-alt transition-colors">Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm font-semibold text-text-primary tabular-nums">{value}</span>
    </div>
  )
}
