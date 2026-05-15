import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { sendUsdtRefund, getSenderAddressFromTx } from '../lib/gas/gas.refund'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'

export async function processGasRefund(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // CAS claim: only proceed if status is still refund_pending.
  // jobId dedup (gas-refund-{orderId}) prevents duplicate jobs, but the CAS
  // is the authoritative guard — protects against manual re-queues.
  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'processGasRefund: order not found — skipping')
    return
  }
  if (order.status !== 'refund_pending') {
    logger.info({ orderId, status: order.status }, 'processGasRefund: order not in refund_pending — already processed')
    return
  }
  if (!order.paymentTxHash) {
    logger.warn({ orderId }, 'processGasRefund: no paymentTxHash — cannot determine refund destination, marking failed')
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: 'refund_skipped: no payment tx hash on record' },
    })
    await sendAdminAlertEmail(
      'Gas Refund Skipped — No Payment Tx Hash',
      `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\n\nThis order has no paymentTxHash. Manual review required.`,
    )
    return
  }

  // Lazy-load sender address from the payment tx if not already stored
  let senderAddress = order.paymentSenderAddress
  if (!senderAddress) {
    senderAddress = await getSenderAddressFromTx(order.chain as GasChainId, order.paymentTxHash)
    if (senderAddress) {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { paymentSenderAddress: senderAddress },
      })
    }
  }

  if (!senderAddress) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 5
    logger.warn({ orderId, attempt: attemptNumber }, 'processGasRefund: could not resolve sender address from tx — will retry')
    if (attemptNumber >= maxAttempts) {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'failed', failureReason: 'refund_failed: could not resolve sender address after all retries' },
      })
      await sendAdminAlertEmail(
        'Gas Refund Failed — Sender Address Unresolvable',
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nPayment Tx: ${order.paymentTxHash}\n\nFailed to resolve sender address after ${maxAttempts} attempts. Manual refund required.`,
      )
    }
    throw new Error('SENDER_ADDRESS_UNRESOLVABLE')
  }

  try {
    const refundTxHash = await sendUsdtRefund(
      order.chain as GasChainId,
      senderAddress,
      order.paymentAmount,
    )

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        status: 'refunded',
        refundTxHash,
        refundAmount: order.paymentAmount,
        refundedAt: new Date(),
      },
    })

    appendLedgerEntry({
      entryType:      'delivery_refund',
      chain:          order.chain as GasChainId,
      nativeAmount:   -Number(order.paymentAmount),
      usdAmount:      Number(order.paymentAmount),
      txHash:         refundTxHash,
      toAddress:      senderAddress,
      relatedOrderId: orderId,
      notes:          `USDT refund for order ${order.orderRef}`,
      ...(order.fromHotWallet ? { fromAddress: order.fromHotWallet } : {}),
    }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write refund ledger entry'))

    logger.info(
      { orderId, refundTxHash, chain: order.chain, senderAddress, amount: order.paymentAmount },
      'Gas order refunded successfully',
    )
    await notifyMerchantWebhook(orderId, 'refunded')
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 5
    const errMsg = err instanceof Error ? err.message : String(err)

    logger.error({ orderId, attempt: attemptNumber, err: errMsg, chain: order.chain }, 'Gas refund send failed')

    if (attemptNumber >= maxAttempts) {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'failed', failureReason: `refund_failed after ${maxAttempts} attempts: ${errMsg}` },
      })
      await notifyMerchantWebhook(orderId, 'failed')
      await sendAdminAlertEmail(
        'Gas Refund Failed After All Retries',
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nRefund to: ${senderAddress}\nAmount: ${order.paymentAmount} USDT\nError: ${errMsg}\n\nManual refund required.`,
      )
    } else {
      throw err
    }
  }
}
