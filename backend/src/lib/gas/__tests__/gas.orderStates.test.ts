import { describe, it, expect } from 'vitest'
import {
  GAS_ACTIVE_STATUSES,
  MANUAL_DELIVERY_WHERE,
  PAID_FAILED_WHERE,
  isManualProofOrder,
  isPaidFailed,
  manualDeliveryIneligibleReason,
  normalizeTxHash,
  type OrderStateFacts,
} from '../gas.orderStates'

const base: OrderStateFacts = {
  status: 'payment_detected',
  paymentCoin: 'USDT',
  paymentNetwork: 'BEP20',
  paymentTxHash: '0xabc',
  retryCount: 0,
  deliveryTxHash: null,
  failureReason: null,
  expiresAt: new Date(Date.now() + 3_600_000),
}
const order = (o: Partial<OrderStateFacts>): OrderStateFacts => ({ ...base, ...o })

describe('gas order status groups', () => {
  it('active = every non-terminal pre-delivery status', () => {
    expect([...GAS_ACTIVE_STATUSES]).toEqual([
      'payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending',
    ])
  })

  it('identifies manual-review rails', () => {
    expect(isManualProofOrder({ paymentCoin: 'PKR', paymentNetwork: 'BANK' })).toBe(true)
    expect(isManualProofOrder({ paymentCoin: 'USDT', paymentNetwork: 'EXCHANGE' })).toBe(true)
    expect(isManualProofOrder({ paymentCoin: 'USDT', paymentNetwork: 'BEP20' })).toBe(false)
  })
})

describe('manual delivery eligibility', () => {
  it('allows a stuck paid order and the post-failure holding window', () => {
    expect(manualDeliveryIneligibleReason(order({ status: 'payment_detected' }))).toBeNull()
    expect(manualDeliveryIneligibleReason(order({ status: 'awaiting_refund', retryCount: 3 }))).toBeNull()
  })

  it('allows a failed order only if payment was actually accepted', () => {
    expect(manualDeliveryIneligibleReason(order({ status: 'failed', retryCount: 3, paymentTxHash: null }))).toBeNull()
    expect(manualDeliveryIneligibleReason(order({ status: 'failed', retryCount: 0, paymentTxHash: '0xabc' }))).toBeNull()
    // legacy rejected/cancelled proof: failed, never retried, no payment tx
    expect(manualDeliveryIneligibleReason(order({ status: 'failed', retryCount: 0, paymentTxHash: null }))).not.toBeNull()
  })

  it('blocks double delivery, refunded, cancelled, expired, in-flight and unpaid orders', () => {
    expect(manualDeliveryIneligibleReason(order({ status: 'delivered' }))).toMatch(/already been delivered/)
    expect(manualDeliveryIneligibleReason(order({ status: 'payment_detected', deliveryTxHash: '0xdead' }))).toMatch(/already been delivered/)
    expect(manualDeliveryIneligibleReason(order({ status: 'sending' }))).toMatch(/in progress/)
    expect(manualDeliveryIneligibleReason(order({ status: 'refund_pending' }))).toMatch(/refund/)
    expect(manualDeliveryIneligibleReason(order({ status: 'refunded' }))).toMatch(/refund/)
    expect(manualDeliveryIneligibleReason(order({ status: 'cancelled' }))).toMatch(/cancelled/)
    expect(manualDeliveryIneligibleReason(order({ status: 'expired' }))).toMatch(/expired/)
    expect(manualDeliveryIneligibleReason(order({ status: 'payment_uploaded' }))).toMatch(/not been accepted/)
    expect(manualDeliveryIneligibleReason(order({ status: 'payment_pending' }))).toMatch(/not been accepted/)
  })

  it('the atomic CAS filter requires no delivery tx yet and mirrors the paid-failed rule', () => {
    expect(MANUAL_DELIVERY_WHERE.deliveryTxHash).toBeNull()
    const or = MANUAL_DELIVERY_WHERE.OR as unknown[]
    expect(or).toContainEqual({ status: { in: ['payment_detected', 'awaiting_refund'] } })
    expect(or).toContainEqual(PAID_FAILED_WHERE)
  })
})

describe('paid-failed rule (retry / refund / manual delivery)', () => {
  it('rejected or cancelled proofs are never paid-failed', () => {
    expect(isPaidFailed({ status: 'failed', retryCount: 0, paymentTxHash: null, failureReason: 'Payment proof rejected by admin' })).toBe(false)
    expect(isPaidFailed({ status: 'cancelled', retryCount: 0, paymentTxHash: '0x1', failureReason: null })).toBe(false)
  })
  it('delivery failures and skipped refunds are paid-failed', () => {
    expect(isPaidFailed({ status: 'failed', retryCount: 3, paymentTxHash: null, failureReason: 'rpc down' })).toBe(true)
    expect(isPaidFailed({ status: 'failed', retryCount: 0, paymentTxHash: null, failureReason: 'refund_skipped: no payment tx hash on record' })).toBe(true)
  })
})

describe('normalizeTxHash', () => {
  it('accepts hashes from every supported chain format', () => {
    expect(normalizeTxHash('0x' + 'a'.repeat(64))).toBe('0x' + 'a'.repeat(64))   // EVM / Aptos
    expect(normalizeTxHash('b'.repeat(64))).not.toBeNull()                         // TRON
    expect(normalizeTxHash('5' + 'K'.repeat(86))).not.toBeNull()                   // Solana base58
    expect(normalizeTxHash('  ' + '0x' + 'c'.repeat(64) + '  ')).toBe('0x' + 'c'.repeat(64))
  })
  it('rejects empty, short, long or malformed input', () => {
    expect(normalizeTxHash('')).toBeNull()
    expect(normalizeTxHash('0x123')).toBeNull()
    expect(normalizeTxHash('x'.repeat(129))).toBeNull()
    expect(normalizeTxHash('0x' + 'a'.repeat(30) + ' ' + 'b'.repeat(30))).toBeNull()
    expect(normalizeTxHash(12345)).toBeNull()
    expect(normalizeTxHash(null)).toBeNull()
  })
})
