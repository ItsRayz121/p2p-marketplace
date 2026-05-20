import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { deliverGas } from '../lib/gas/gas.delivery'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import { queues } from '../queues/definitions'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { fromDbChain } from '../lib/gas/gas.chains'
import { selectHotWallet } from '../lib/gas/gasWalletService'
import { createAdminNotif } from '../services/adminNotification.service'

export async function processGasFeeOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // Respect the global pause switch — requeue with backoff if paused.
  const globalPause = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
  if (globalPause?.value === '1') {
    logger.warn({ orderId }, 'Gas delivery skipped — global pause is active')
    throw new Error('Gas delivery globally paused — will retry')
  }

  // DB-level CAS: atomically claim the order by transitioning payment_detected → sending.
  // If another worker process already claimed it, updateMany returns count=0 and we exit
  // immediately — no double-send is possible even under concurrent retries.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'payment_detected' },
    data: { status: 'sending' },
  })

  if (claimed.count === 0) {
    logger.info({ orderId }, 'Gas order already claimed or not in payment_detected — skipping')
    return
  }

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'Gas fee order not found after status claim — this should not happen')
    return
  }

  try {
    // Select load-balanced hot wallet for this chain, stamp on order before delivery
    const hotWallet = await selectHotWallet(order.chain).catch(() => null)
    if (hotWallet && hotWallet.address !== order.fromHotWallet) {
      await db.gasFeeOrder.update({ where: { id: orderId }, data: { fromHotWallet: hotWallet.address } })
    }
    const hdIndex = hotWallet?.hdIndex ?? 0

    const deliveryTxHash = await deliverGas(order, hdIndex)

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        status: 'delivered',
        deliveryTxHash,
        deliveryConfirmed: false,
        deliveredAt: new Date(),
        fromHotWallet: hotWallet?.address ?? order.fromHotWallet,
      },
    })

    appendLedgerEntry({
      entryType:      'gas_delivery',
      chain:          fromDbChain(order.chain) as GasChainId,
      nativeAmount:   -Number(order.gasAmountNative),
      usdAmount:      Number(order.gasAmountUSD),
      txHash:         deliveryTxHash,
      toAddress:      order.toAddress,
      relatedOrderId: orderId,
      notes:          `Delivery for order ${order.orderRef}`,
      ...(order.fromHotWallet ? { fromAddress: order.fromHotWallet } : {}),
    }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write delivery ledger entry'))

    // Enqueue on-chain confirmation check 60s after send (10 retries × 60s = 10 min window)
    await queues.gasFee.add(
      'check-delivery',
      { orderId, txHash: deliveryTxHash },
      {
        delay: 60_000,
        jobId: `gas-check-delivery-${orderId}`,
        attempts: 10,
        backoff: { type: 'fixed', delay: 60_000 },
      },
    )

    logger.info({ orderId, deliveryTxHash, chain: order.chain }, 'Gas fee delivered successfully')
    await notifyMerchantWebhook(orderId, 'delivered')
    void createAdminNotif({
      category: 'GAS',
      title: `Gas Sent — ${Number(order.gasAmountNative).toFixed(6)} ${order.chain}`,
      body: `Order ${order.orderRef} delivered to ${order.toAddress.slice(0, 10)}… Tx: ${deliveryTxHash.slice(0, 12)}…`,
      href: `/admin/gas/orders/${order.orderRef}`,
      metadata: { txHash: deliveryTxHash, orderId, chain: order.chain, toAddress: order.toAddress, amount: order.gasAmountNative },
    })
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 3
    const errMsg = err instanceof Error ? err.message : String(err)
    const errCode = (err as { code?: string }).code

    logger.error({ orderId, attempt: attemptNumber, err: errMsg, chain: order.chain }, 'Gas fee delivery failed')

    // Insufficient hot wallet balance — don't burn retries on a tx that can't succeed.
    // Reset to payment_detected, alert admin, and let the refill job replenish the wallet
    // before the next delivery attempt is scheduled via the balance monitor.
    if (errCode === 'INSUFFICIENT_HOT_WALLET_BALANCE') {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected', failureReason: errMsg },
      })
      await sendAdminAlertEmail(
        `Gas Delivery Paused — Insufficient Hot Wallet Balance`,
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\n\nThe hot wallet does not have enough native balance to deliver this order. A refill request should be raised. Delivery will resume once the balance is restored.\n\nError: ${errMsg}`,
      ).catch(() => {})
      return
    }

    if (attemptNumber >= maxAttempts) {
      // Final failure: if payment was received, move to refund_pending so the automated
      // refund job can return the USDT. Otherwise mark as failed directly.
      const nextStatus = order.paymentTxHash ? 'refund_pending' : 'failed'
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: nextStatus, failureReason: errMsg, retryCount: attemptNumber },
      })

      if (nextStatus === 'refund_pending') {
        await queues.gasFee.add(
          'process-refund',
          { orderId },
          { jobId: `gas-refund-${orderId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
        )
        logger.info({ orderId }, 'Gas delivery failed — queued for automated refund')
      }

      await notifyMerchantWebhook(orderId, nextStatus)
      await sendAdminAlertEmail(
        `Gas Fee Delivery Failed After ${maxAttempts} Attempts`,
        `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\nNext status: ${nextStatus}`,
      )
    } else {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { retryCount: attemptNumber },
      })
      // Re-open status to payment_detected so the next BullMQ retry can claim it via CAS
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected' },
      })
      throw err
    }
  }
}
