// Single source of truth for CTM USDT-as-payment methods.
//
// Mirrors the backend ctm.usdtPayment CTM_USDT_METHODS list. Both the
// create-listing form (maker) and the take-trade flow (taker) import this so the
// two sides stay in lockstep and can categorise methods the same way the wallet
// "Add Delivery Address" flow does: a Wallet / Blockchain group and an
// Internal / Exchange Transfer group.

export type UsdtMethodKind = 'wallet' | 'exchange'

export interface CtmUsdtMethod {
  /** Stored value (what the API sends/receives). */
  value: string
  /** Human label shown in the UI. */
  label: string
  /** Which group this method belongs to. */
  kind: UsdtMethodKind
  /** Placeholder for the address / UID input. */
  placeholder: string
}

export const CTM_USDT_METHODS: CtmUsdtMethod[] = [
  { value: 'BEP20',   label: 'USDT BEP20',  kind: 'wallet',   placeholder: '0x… wallet address' },
  { value: 'Aptos',   label: 'USDT Aptos',  kind: 'wallet',   placeholder: '0x… Aptos address' },
  { value: 'Binance', label: 'Binance UID', kind: 'exchange', placeholder: 'Your Binance UID' },
  { value: 'OKX',     label: 'OKX UID',     kind: 'exchange', placeholder: 'Your OKX UID' },
  { value: 'Bitget',  label: 'Bitget UID',  kind: 'exchange', placeholder: 'Your Bitget UID' },
  { value: 'Gate',    label: 'Gate UID',    kind: 'exchange', placeholder: 'Your Gate.io UID' },
  { value: 'MEXC',    label: 'MEXC UID',    kind: 'exchange', placeholder: 'Your MEXC UID' },
  { value: 'Other',   label: 'Other UID',   kind: 'exchange', placeholder: 'Your account ID / UID' },
]

/** The two method groups, in display order. */
export const CTM_USDT_METHOD_KINDS: { key: UsdtMethodKind; label: string }[] = [
  { key: 'wallet',   label: 'Wallet / Blockchain' },
  { key: 'exchange', label: 'Internal / Exchange Transfer' },
]

export function ctmUsdtMethod(value: string): CtmUsdtMethod | undefined {
  return CTM_USDT_METHODS.find((m) => m.value === value)
}

/** Group a method value belongs to; unknown values fall back to exchange. */
export function ctmUsdtMethodKind(value: string): UsdtMethodKind {
  return ctmUsdtMethod(value)?.kind ?? 'exchange'
}

/** Human label for a method value (e.g. "USDT BEP20"); safe for unknowns. */
export function ctmUsdtMethodLabel(value: string): string {
  return ctmUsdtMethod(value)?.label ?? `USDT ${value}`
}

/**
 * EntityLogo type/slug for a method chip. Wallet chains (BEP20/Aptos) carry no
 * entry in the chain logo registry, so they'd fall back to a grey initials avatar;
 * since every wallet rail is USDT, show the USDT token mark instead. Exchange rails
 * keep their own brand logo.
 */
export function ctmUsdtMethodLogo(value: string): { type: 'token' | 'exchange'; slug: string } {
  return ctmUsdtMethodKind(value) === 'wallet'
    ? { type: 'token', slug: 'USDT' }
    : { type: 'exchange', slug: value }
}
