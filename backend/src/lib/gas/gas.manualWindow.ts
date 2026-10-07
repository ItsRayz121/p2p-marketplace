/**
 * Time windows for MANUAL payment orders (PKR bank/wallet transfers and exchange transfers).
 *
 * - Payment window: how long the user has to pay and upload their proof after creating the
 *   order. If they don't, the order expires and they start a new one (default 30 min).
 * - Review window: once a proof IS uploaded, the order must not expire while the team is
 *   offline (e.g. sleeping hours), so the deadline is extended to this (default 24 h).
 */
import { getNumberConfig } from '../../services/platformFlags.service'

export const MANUAL_PAYMENT_WINDOW_KEY = 'gas_manual_payment_window_minutes'
export const MANUAL_REVIEW_WINDOW_KEY = 'gas_manual_review_window_hours'
export const MANUAL_LATE_PROOF_GRACE_KEY = 'gas_manual_late_proof_grace_minutes'

export async function manualPaymentWindowMs(): Promise<number> {
  const mins = await getNumberConfig(MANUAL_PAYMENT_WINDOW_KEY, 30)
  return Math.min(Math.max(mins, 5), 120) * 60_000
}

export async function manualReviewWindowMs(): Promise<number> {
  const hours = await getNumberConfig(MANUAL_REVIEW_WINDOW_KEY, 24)
  return Math.min(Math.max(hours, 1), 168) * 3_600_000
}

/**
 * Grace after expiry during which a proof is still accepted. Covers the user who really did
 * pay (bank apps can be slow) but uploaded the screenshot after the window closed, so their
 * money is never stranded without an order. Default 2 hours.
 */
export async function manualLateProofGraceMs(): Promise<number> {
  const mins = await getNumberConfig(MANUAL_LATE_PROOF_GRACE_KEY, 120)
  return Math.min(Math.max(mins, 0), 1440) * 60_000
}

/** Is this manual order still open for a proof upload (pending, or expired within the grace)? */
export function acceptsProof(order: { status: string; expiresAt: Date }, graceMs: number, now = Date.now()): boolean {
  if (order.status !== 'payment_pending' && order.status !== 'expired') return false
  return now - order.expiresAt.getTime() <= graceMs
}
