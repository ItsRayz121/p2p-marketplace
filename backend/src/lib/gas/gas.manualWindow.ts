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

export async function manualPaymentWindowMs(): Promise<number> {
  const mins = await getNumberConfig(MANUAL_PAYMENT_WINDOW_KEY, 30)
  return Math.min(Math.max(mins, 5), 120) * 60_000
}

export async function manualReviewWindowMs(): Promise<number> {
  const hours = await getNumberConfig(MANUAL_REVIEW_WINDOW_KEY, 24)
  return Math.min(Math.max(hours, 1), 168) * 3_600_000
}

/** A manual order accepts a proof only while it is still pending and inside its payment window. Expiry is final. */
export function acceptsProof(order: { status: string; expiresAt: Date }, now = Date.now()): boolean {
  return order.status === 'payment_pending' && order.expiresAt.getTime() >= now
}
