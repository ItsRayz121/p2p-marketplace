'use client'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useGasCtx } from './GasContext'

// Promo-code entry (margin-only discount). Rendered on every screen that runs
// BEFORE order creation — the choice screen and the two confirm screens — so the
// discount can still bake into the order amount. All instances share one piece of
// context state, so entering/removing a code anywhere updates everywhere.
// Hidden entirely unless the gas_promo_enabled flag is ON.
//
// Collapsed by default into a "Have a promo code?" dropdown so it doesn't add
// visual noise for the majority who don't have one; expands inline on tap.
export function GasPromoField() {
  const {
    promoEnabled, promoCode, setPromoCode, promoApplied,
    promoError, promoChecking, applyPromo, clearPromo,
    freeCodeApplied,
  } = useGasCtx()
  const [open, setOpen] = useState(false)

  // A free code (100% off) makes a margin-only promo discount moot — hide this
  // field while one is applied so the two can't be mixed in the same order.
  if (!promoEnabled || freeCodeApplied) return null

  return (
    <div className="rounded-xl border border-border bg-surface-alt/50 p-3.5">
      {!promoApplied ? (
        <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="flex w-full items-center justify-between text-xs font-semibold text-text-primary"
            aria-expanded={open}
          >
            <span>Have a promo code?</span>
            <ChevronDown size={16} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="mt-2">
              <div className="flex gap-2">
                <input
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyPromo() } }}
                  placeholder="Enter code"
                  maxLength={40}
                  autoFocus
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
            </div>
          )}
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
  )
}

// Read-only confirmation shown on the post-order screens (QR / proof), where the
// order amount is already locked to the discounted value. Surfaces the saving so
// the user sees both the original ("cut") and the final price. No-op when no promo
// was applied in this session.
export function GasPromoApplied() {
  const { promoApplied } = useGasCtx()
  if (!promoApplied || promoApplied.discountUsdt <= 0) return null
  return (
    <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-green-700 dark:text-green-300">
        Promo {promoApplied.code} applied — {promoApplied.discountPct}% off the platform fee
      </p>
      <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
        You saved ${promoApplied.discountUsdt.toFixed(2)} · the amount below is already discounted.
      </p>
    </div>
  )
}

// Celebratory affiliate-discount banner. Surfaces the buyer's automatic margin-only
// discount (and who it's courtesy of) on the payment screens. Prefers the snapshot
// persisted on the order (so it survives a refresh / works on the tracking link), and
// falls back to the live session quote on the pre-order screens. No-op when there is no
// affiliate discount.
export function GasAffiliateApplied() {
  const { affiliateQuote, affiliateDiscountUsd, order } = useGasCtx()

  // Refresh-proof path: read the snapshot baked onto the order.
  const orderDisc = order ? Number(order.affiliateDiscountUsdt ?? 0) : 0
  if (order && orderDisc > 0) {
    const margin = Number(order.platformMarginUsdt ?? 0)
    const pct = margin > 0 ? Math.round((orderDisc / margin) * 100) : 0
    const referrer = order.affiliateReferrer || 'your referral link'
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2">
        <p className="text-xs font-semibold text-green-700 dark:text-green-300">
          🎉 {pct > 0 ? `${pct}% ` : ''}affiliate discount applied
        </p>
        <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
          You saved ${orderDisc.toFixed(2)} courtesy of {referrer}&apos;s link — the amount below is already discounted.
        </p>
      </div>
    )
  }

  // Pre-order path: live session quote.
  if (!affiliateQuote || affiliateDiscountUsd <= 0) return null
  return (
    <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2">
      <p className="text-xs font-semibold text-green-700 dark:text-green-300">
        🎉 {affiliateQuote.discountPct}% affiliate discount applied
      </p>
      <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
        You saved ${affiliateDiscountUsd.toFixed(2)} courtesy of {affiliateQuote.referrerLabel}&apos;s link — the amount below is already discounted.
      </p>
    </div>
  )
}
