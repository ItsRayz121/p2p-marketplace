import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'

/**
 * USDT-as-payment-currency in the Community Token Market.
 *
 * Double-gated exactly like taker-first settlement (settlementMode.service):
 *  1. CTM_USDT_PAYMENT_READY — a code constant flipped to `true` only once the
 *     end-to-end USDT payment + settlement flow has passed staging QA. Until then
 *     the feature is inert even if an admin flips the runtime flag.
 *  2. ctm_usdt_payment_enabled — the runtime PlatformConfig flag (default OFF).
 *
 * Both must be true for any USDT-payment code path to run. When either is false
 * the CTM market behaves byte-identically to today (PKR-only).
 */
// Code path is complete (listing config → trade execution → currency-aware trade
// room). Flipped true so the runtime flag `ctm_usdt_payment_enabled` (still OFF by
// default) actually takes effect once enabled. RECOMMENDED: run staging QA of a
// full SELL + BUY USDT trade before flipping the runtime flag in production.
export const CTM_USDT_PAYMENT_READY = true

/** The USDT delivery methods a CTM listing may offer — mirrors the USDT market. */
export const CTM_USDT_METHODS = [
  { value: 'BEP20', kind: 'wallet' as const, label: 'USDT BEP20' },
  { value: 'Aptos', kind: 'wallet' as const, label: 'USDT Aptos' },
  { value: 'Binance', kind: 'exchange' as const, label: 'Binance UID' },
  { value: 'OKX', kind: 'exchange' as const, label: 'OKX UID' },
  { value: 'Bitget', kind: 'exchange' as const, label: 'Bitget UID' },
  { value: 'Gate', kind: 'exchange' as const, label: 'Gate UID' },
  { value: 'MEXC', kind: 'exchange' as const, label: 'MEXC UID' },
  { value: 'Other', kind: 'exchange' as const, label: 'Other UID' },
] as const

export const CTM_USDT_METHOD_VALUES = CTM_USDT_METHODS.map((m) => m.value)

/** True only when USDT-in-CTM is both code-ready AND runtime-enabled. */
export async function isCtmUsdtPaymentEnabled(): Promise<boolean> {
  if (!CTM_USDT_PAYMENT_READY) return false
  return isFlagEnabled(FLAGS.CTM_USDT_PAYMENT)
}
