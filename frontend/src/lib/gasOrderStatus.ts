/**
 * Shared gas-order status presentation + action-eligibility helpers for the admin UI.
 * The backend re-validates every action atomically — these only decide which buttons
 * to show, mirroring backend/src/lib/gas/gas.orderStates.ts.
 */

export const GAS_STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_verified: 'Payment Verified',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering...',
  delivered:        'Delivered',
  expired:          'Expired',
  failed:           'Failed',
  awaiting_refund:  'Delivery Delayed (Refund Window)',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
  cancelled:        'Cancelled',
}

export const gasStatusLabel = (s: string): string =>
  GAS_STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export type GasStatusVariant = 'success' | 'danger' | 'warning' | 'default' | 'outline'

export function gasStatusVariant(s: string): GasStatusVariant {
  if (s === 'delivered' || s === 'payment_verified') return 'success'
  if (s === 'failed' || s === 'expired' || s === 'cancelled') return 'danger'
  if (s === 'refunded' || s === 'awaiting_refund' || s === 'refund_pending' || s === 'payment_uploaded') return 'warning'
  if (s === 'payment_detected' || s === 'sending') return 'default'
  return 'outline'
}

export interface GasOrderFacts {
  status: string
  paymentCoin?: string | null
  paymentNetwork?: string | null
  paymentTxHash?: string | null
  retryCount?: number | null
  failureReason?: string | null
  deliveryTxHash?: string | null
}

export const isManualProofOrder = (o: GasOrderFacts) => o.paymentCoin === 'PKR' || o.paymentNetwork === 'EXCHANGE'

/** A failed order counts as paid only if a payment was demonstrably accepted. */
export function isPaidFailed(o: GasOrderFacts): boolean {
  return o.status === 'failed'
    && ((o.retryCount ?? 0) > 0 || !!o.paymentTxHash || (o.failureReason ?? '').startsWith('refund_skipped'))
}

/** Reject applies to a manual-review proof that is awaiting a decision. */
export const canRejectProof = (o: GasOrderFacts) => o.status === 'payment_uploaded' && isManualProofOrder(o)

/** Manual delivery: payment accepted, gas never left the platform. */
export function canManualDeliver(o: GasOrderFacts): boolean {
  if (o.deliveryTxHash) return false
  return o.status === 'payment_detected' || o.status === 'awaiting_refund' || isPaidFailed(o)
}
