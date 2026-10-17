import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  find: vi.fn(), updateMany: vi.fn(), update: vi.fn(), audit: vi.fn(),
  qAdd: vi.fn(), qRemove: vi.fn(), notify: vi.fn(), gasAudit: vi.fn(), assess: vi.fn(), handBack: vi.fn(),
}))

vi.mock('../../lib/prisma', () => ({
  db: { gasFeeOrder: { findUnique: m.find, updateMany: m.updateMany, update: m.update }, auditLog: { create: m.audit } },
}))
vi.mock('../../queues/definitions', () => ({ queues: { gasFee: { add: m.qAdd, remove: m.qRemove } } }))
vi.mock('../../lib/notify', () => ({ notify: m.notify }))
vi.mock('../../lib/gas/gas.matching', () => ({ recordGasAudit: m.gasAudit }))
vi.mock('../../lib/gas/gas.attemptSafety', () => ({ assessPriorAttempt: m.assess, handBackLandedDelivery: m.handBack }))

import { approveManualGasPayment, rejectManualGasPayment, retryGasDelivery } from '../gasAdminActions.service'

const actor = { id: 'admin1', via: 'telegram' as const }
const future = () => new Date(Date.now() + 3600_000)
const order = (o: Record<string, unknown> = {}) => ({
  id: 'o1', orderRef: 'GF-1', status: 'payment_uploaded', paymentCoin: 'PKR', paymentNetwork: 'BANK', pkrAmount: null, userId: 'u1',
  expiresAt: future(), unconfirmedDeliveryTxHash: null, deliveryNonce: null, ...o,
})

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.find.mockResolvedValue(order())
  m.updateMany.mockResolvedValue({ count: 1 })
  m.qAdd.mockResolvedValue({})
})

describe('approve', () => {
  it('queues the delivery once and audits the admin and the route', async () => {
    const r = await approveManualGasPayment('o1', actor)
    expect(r).toEqual({ status: 'payment_detected', orderRef: 'GF-1' })
    expect(m.qAdd).toHaveBeenCalledTimes(1)
    expect(m.audit.mock.calls[0]![0].data).toMatchObject({ actorId: 'admin1', action: 'GAS_PKR_APPROVED', metadata: { via: 'telegram', newStatus: 'payment_detected' } })
  })
  it('refuses an order that is not waiting for review, and an expired one', async () => {
    m.find.mockResolvedValue(order({ status: 'delivered' }))
    await expect(approveManualGasPayment('o1', actor)).rejects.toMatchObject({ statusCode: 409 })
    m.find.mockResolvedValue(order({ expiresAt: new Date(Date.now() - 1000) }))
    await expect(approveManualGasPayment('o1', actor)).rejects.toMatchObject({ code: 'ORDER_EXPIRED' })
    expect(m.qAdd).not.toHaveBeenCalled()
  })
  it('never queues a second delivery when another admin already took the order', async () => {
    m.updateMany.mockResolvedValue({ count: 0 })
    await expect(approveManualGasPayment('o1', actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(m.qAdd).not.toHaveBeenCalled()
  })
})

describe('reject', () => {
  it('cancels the order, sends nothing, and tells the customer', async () => {
    const r = await rejectManualGasPayment('o1', 'Payment could not be verified', actor)
    expect(r.status).toBe('cancelled')
    expect(m.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'cancelled' })
    expect(m.qAdd).not.toHaveBeenCalled()
    expect(m.notify).toHaveBeenCalledTimes(1)
    expect(m.audit.mock.calls[0]![0].data).toMatchObject({ action: 'GAS_PKR_REJECTED' })
  })
  it('is refused when the proof is no longer awaiting review', async () => {
    m.updateMany.mockResolvedValue({ count: 0 })
    m.find.mockResolvedValueOnce(order()).mockResolvedValueOnce({ status: 'payment_detected' })
    await expect(rejectManualGasPayment('o1', undefined, actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(m.notify).not.toHaveBeenCalled()
  })
})

describe('retry', () => {
  it('re-queues a failed order that took a payment', async () => {
    await retryGasDelivery('o1', actor)
    expect(m.qAdd).toHaveBeenCalledTimes(1)
    expect(m.audit.mock.calls.at(-1)![0].data).toMatchObject({ action: 'GAS_ORDER_RETRY', metadata: { via: 'telegram' } })
  })
  it('does not retry an order that never had a payment accepted', async () => {
    m.updateMany.mockResolvedValue({ count: 0 })
    m.find.mockResolvedValue(order({ status: 'failed' }))
    await expect(retryGasDelivery('o1', actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(m.qAdd).not.toHaveBeenCalled()
  })
  it('is blocked while the earlier delivery transaction might still land', async () => {
    m.find.mockResolvedValue(order({ unconfirmedDeliveryTxHash: '0xold' }))
    m.assess.mockResolvedValue({ verdict: 'unresolved', detail: 'Still pending.' })
    await expect(retryGasDelivery('o1', actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(m.qAdd).not.toHaveBeenCalled()
    expect(m.updateMany).not.toHaveBeenCalled()
  })
  it('adopts a delivery that had actually landed instead of sending again', async () => {
    m.find.mockResolvedValue(order({ unconfirmedDeliveryTxHash: '0xold' }))
    m.assess.mockResolvedValue({ verdict: 'landed', txHash: '0xold' })
    const r = await retryGasDelivery('o1', actor)
    expect(r.message).toMatch(/Nothing was resent/)
    expect(m.handBack).toHaveBeenCalledWith('o1', '0xold')
    expect(m.qAdd).not.toHaveBeenCalled()
  })
  it('clears the journal and sends once more only when the earlier attempt is proven dead', async () => {
    m.find.mockResolvedValue(order({ unconfirmedDeliveryTxHash: '0xold', deliveryNonce: 5 }))
    m.assess.mockResolvedValue({ verdict: 'dead', txHash: '0xold', detail: 'reverted' })
    await retryGasDelivery('o1', actor)
    expect(m.updateMany.mock.calls[0]![0].data).toMatchObject({ unconfirmedDeliveryTxHash: null })
    expect(m.qAdd).toHaveBeenCalledTimes(1)
  })
})
