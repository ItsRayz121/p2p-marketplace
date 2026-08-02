'use client'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useGasCtx } from './GasContext'

// KOL "100% free gas" code entry — waives the ENTIRE order cost (base + margin)
// and gives a FIXED gas amount set by the KOL (e.g. 0.00001 BNB), not whatever
// amount the user typed above — unlike a promo code which only ever discounts
// the platform margin on the user's own chosen amount. Rendered on every screen
// that runs BEFORE order creation (mirrors GasPromoField). Hidden entirely
// unless the caller is eligible (flag ON, logged in, first-ever gas order — see
// /gas-fee/chains freeCodeEnabled, which encodes per-user eligibility, not just
// the flag) — so this box genuinely never appears again after a user's first
// order — or while a promo code is applied (the two are mutually exclusive).
//
// Collapsed by default into a "Have a KOL free-gas code?" dropdown.
export function GasFreeCodeField() {
  const {
    freeCodeEnabled, freeCode, setFreeCode, freeCodeApplied,
    freeCodeError, freeCodeChecking, applyFreeCode, clearFreeCode,
    promoApplied, selectedToken,
  } = useGasCtx()
  const [open, setOpen] = useState(false)

  if (!freeCodeEnabled || promoApplied) return null

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
      {!freeCodeApplied ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="flex w-full items-center justify-between text-xs font-semibold text-text-primary"
            aria-expanded={open}
          >
            <span>Have a KOL free-gas code? 🎉</span>
            <ChevronDown size={16} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  value={freeCode}
                  onChange={(e) => setFreeCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFreeCode() } }}
                  placeholder="Enter code"
                  maxLength={40}
                  autoFocus
                  className="flex-1 min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm uppercase tracking-wide focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <button
                  onClick={applyFreeCode}
                  disabled={freeCodeChecking || !freeCode.trim()}
                  className="shrink-0 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
                >
                  {freeCodeChecking ? 'Checking…' : 'Apply'}
                </button>
              </div>
              {freeCodeError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{freeCodeError}</p>}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-amber-700 dark:text-amber-300">
              🎉 Code {freeCodeApplied.code} applied — you&apos;ll receive {freeCodeApplied.amountNative} {selectedToken?.symbol ?? ''} FREE
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              Courtesy of {freeCodeApplied.kolLabel} · this is fixed by the code — the amount you entered above doesn&apos;t apply
              {freeCodeApplied.slotsLeft > 0 ? ` · ${freeCodeApplied.slotsLeft} ${freeCodeApplied.slotsLeft === 1 ? 'slot' : 'slots'} left` : ''}
            </p>
          </div>
          <button onClick={clearFreeCode} className="shrink-0 text-xs font-semibold text-text-muted hover:text-text-primary underline">
            Remove
          </button>
        </div>
      )}
    </div>
  )
}

// Read-only confirmation shown on the processing/tracking screens, where the
// order is already locked in as free. No-op when no free code was applied.
export function GasFreeCodeApplied() {
  const { order } = useGasCtx()
  if (!order?.isFreeGrant) return null
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
        🎉 {order.freeCode ? `Code ${order.freeCode} applied — ` : ''}you received {order.gasAmountNative} {order.nativeSymbol ?? ''} FREE
      </p>
      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
        The platform covered the full gas cost — no payment was needed.
      </p>
    </div>
  )
}
