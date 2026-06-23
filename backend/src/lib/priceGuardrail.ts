/**
 * Price-margin guardrail. A listing's price must stay within ±marginPct of the
 * reference price — and the reference is OUR OWN marketplace average (not an
 * external oracle), so the platform stays internally consistent. This blocks the
 * deceptive-pricing vector: e.g. listing USDT at 320 when the market is 288, or a
 * CTM token at 20 when its market is 10.
 *
 * Disabled (always ok) when there is no reference yet (bootstrapping: the first
 * listings define the market) or when marginPct <= 0 (admin turned it off).
 */
export interface MarginCheckResult {
  ok: boolean
  /** Lower bound of the allowed band (only when enforced). */
  min?: number
  /** Upper bound of the allowed band (only when enforced). */
  max?: number
}

export function checkPriceMargin(price: number, reference: number | null | undefined, marginPct: number): MarginCheckResult {
  if (!reference || reference <= 0 || !marginPct || marginPct <= 0 || !Number.isFinite(price)) {
    return { ok: true }
  }
  const min = reference * (1 - marginPct / 100)
  const max = reference * (1 + marginPct / 100)
  return { ok: price >= min && price <= max, min, max }
}

/** Human-readable rejection message for an out-of-band price. */
export function marginRejectionMessage(opts: {
  unitLabel: string // e.g. 'USDT' or 'SDA'
  marginPct: number
  min: number
  max: number
}): string {
  const fmt = (n: number) => n.toFixed(2)
  return `Price is too far from the current market rate. To protect buyers, a listing must be within ±${opts.marginPct}% of the marketplace average — between PKR ${fmt(opts.min)} and PKR ${fmt(opts.max)} per ${opts.unitLabel}.`
}
