import type { Prisma } from '@prisma/client'

/**
 * Single source of truth for gas-order status groups and admin-action eligibility.
 * Pure functions only (no I/O) so the rules are unit-testable; the routes still
 * enforce them atomically in the database with a compare-and-set update.
 */

/** Orders still in flight (pre-delivery, not terminal) — the "Gas Orders Active" KPI. */
export const GAS_ACTIVE_STATUSES = [
  'payment_pending',
  'payment_uploaded',
  'payment_verified',
  'payment_detected',
  'sending',
] as const

/** Manual-review payment rails (PKR bank transfer, exchange internal transfer). */
export const MANUAL_PROOF_WHERE: Prisma.GasFeeOrderWhereInput = {
  OR: [{ paymentCoin: 'PKR' }, { paymentNetwork: 'EXCHANGE' }],
}

/**
 * A 'failed' order only counts as PAID (and so is eligible for Retry / Manual
 * Delivery / Refund) when the platform demonstrably accepted a payment: a delivery
 * was attempted, a payment tx is on record, or an auto-refund was skipped for lack
 * of a tx hash. A 'failed' order that never had payment accepted (legacy rejected /
 * cancelled proofs) must never be retried or refunded.
 */
export const PAID_FAILED_WHERE: Prisma.GasFeeOrderWhereInput = {
  status: 'failed',
  OR: [
    { retryCount: { gt: 0 } },
    { paymentTxHash: { not: null } },
    { failureReason: { startsWith: 'refund_skipped' } },
  ],
}

export function isPaidFailed(o: Pick<OrderStateFacts, 'status' | 'retryCount' | 'paymentTxHash' | 'failureReason'>): boolean {
  return o.status === 'failed'
    && (o.retryCount > 0 || !!o.paymentTxHash || (o.failureReason ?? '').startsWith('refund_skipped'))
}

export interface OrderStateFacts {
  status: string
  failureReason?: string | null
  paymentCoin: string
  paymentNetwork: string
  paymentTxHash: string | null
  retryCount: number
  deliveryTxHash: string | null
  expiresAt: Date
}

export function isManualProofOrder(o: Pick<OrderStateFacts, 'paymentCoin' | 'paymentNetwork'>): boolean {
  return o.paymentCoin === 'PKR' || o.paymentNetwork === 'EXCHANGE'
}

/** Statuses from which a manual-proof order may be rejected (proof awaiting review). */
export const REJECTABLE_STATUS = 'payment_uploaded'

/**
 * Manual delivery is only for orders whose payment is already accepted but whose
 * gas never left the platform: stuck with an empty hot wallet (payment_detected),
 * in the post-failure holding window (awaiting_refund), or failed AFTER a payment
 * was accepted (a retry was attempted or a payment tx is on record). Anything that
 * was rejected/cancelled/refunded — or is mid-send — is excluded.
 */
export const MANUAL_DELIVERY_STATUSES = ['payment_detected', 'awaiting_refund'] as const

export function manualDeliveryIneligibleReason(o: OrderStateFacts): string | null {
  if (o.deliveryTxHash || o.status === 'delivered') return 'This order has already been delivered.'
  if (o.status === 'sending') return 'Delivery is in progress — wait for it to finish or fail before delivering manually.'
  if (['refund_pending', 'refunded'].includes(o.status)) return 'This order is being refunded or was refunded.'
  if (['cancelled', 'expired'].includes(o.status)) return `This order is ${o.status}; it cannot receive gas.`
  if ((MANUAL_DELIVERY_STATUSES as readonly string[]).includes(o.status)) return null
  if (isPaidFailed({ ...o, failureReason: o.failureReason ?? null })) return null
  return `Payment has not been accepted for this order (status: ${o.status}).`
}

/** Prisma `where` fragment that atomically re-checks eligibility inside the CAS update. */
export const MANUAL_DELIVERY_WHERE: Prisma.GasFeeOrderWhereInput = {
  deliveryTxHash: null,
  OR: [
    { status: { in: [...MANUAL_DELIVERY_STATUSES] } },
    PAID_FAILED_WHERE,
  ],
}

/** A transaction hash sanity check that covers every supported chain's format. */
export function normalizeTxHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (v.length < 20 || v.length > 128) return null
  if (!/^[A-Za-z0-9+/=_\-:.]+$/.test(v)) return null
  return v
}
