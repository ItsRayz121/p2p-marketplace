import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { sendUsdtRefund, getSenderAddressFromTx } from '../lib/gas/gas.refund'
import { sendAptosUsdtRefund, getAptosSenderFromTx } from '../lib/gas/aptosRefund'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { createAdminNotif } from '../services/adminNotification.service'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { fromDbChain, paymentNetworkSettlementChain } from '../lib/gas/gas.chains'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'

// USDT was received on the PAYMENT network (e.g. BEP20 / Aptos), which can differ
// from the gas-DELIVERY chain (e.g. TON). The refund must go back on the chain the
// money actually arrived on — using order.chain would try to refund USDT on a
// chain that never received it (and throw 'unsupported chain' for TON/SOL/SUI).
type RefundPlan =
  | { kind: 'evm_tron'; chain: GasChainId } // EVM/Tron USDT via gas.refund
  | { kind: 'aptos' }                        // Aptos fungible-asset USDT via aptosRefund
  | null

function planRefund(order: { paymentNetwork: string }): RefundPlan {
  if (order.paymentNetwork.toUpperCase() === 'APTOS') return { kind: 'aptos' }
  const settle = paymentNetworkSettlementChain(order.paymentNetwork)
  if (settle) return { kind: 'evm_tron', chain: fromDbChain(settle.dbChain) }
  return null // no automated refund path for this payment network
}

export async function processGasRefund(job: Job<{ orderId: string; toAddressOverride?: string; networkOverride?: string }>) {
  const { orderId, toAddressOverride, networkOverride } = job.data

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
  // A manual refund carries an admin-specified destination, so it does not need a
  // payment tx hash (the admin is overriding the auto sender-resolution path).
  if (!toAddressOverride && !order.paymentTxHash) {
    logger.warn({ orderId }, 'processGasRefund: no paymentTxHash — cannot determine refund destination, marking failed')
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: 'refund_skipped: no payment tx hash on record' },
    })
    void createAdminNotif({
      category: 'GAS',
      title: 'Gas Refund Skipped — No Payment Tx Hash',
      body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\n\nThis order has no paymentTxHash. Manual review required.`,
      href: `/admin/gas/orders/${order.orderRef}`,
      telegram: true,
    })
    return
  }

  // Resolve the chain the USDT actually arrived on (payment network), NOT the
  // gas-delivery chain. For a TON gas order paid via BEP20, this is BSC; for an
  // Aptos-paid order it's the Aptos fungible-asset rail.
  //
  // networkOverride: a manual refund to a user-chosen USDT rail. Essential for
  // PKR-paid orders — those have no crypto payment network to settle on, so the
  // admin (with the address the user supplied in chat) picks the rail explicitly.
  const plan = planRefund(networkOverride ? { paymentNetwork: networkOverride } : order)
  if (!plan) {
    logger.warn({ orderId, paymentNetwork: order.paymentNetwork }, 'processGasRefund: no auto-refund support for payment network — manual refund required')
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: `refund_failed: no automated USDT refund for payment network ${order.paymentNetwork} — manual refund required` },
    })
    void createAdminNotif({
      category: 'GAS',
      title: 'Gas Refund Needs Manual Action — Unsupported Payment Network',
      body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nDelivery chain: ${order.chain}\nPayment network: ${order.paymentNetwork}\nAmount: ${order.paymentAmount} USDT\nPayment Tx: ${order.paymentTxHash}\n\nAutomated USDT refund is not implemented for this payment network. Send ${order.paymentAmount} USDT back to the sender manually.`,
      href: `/admin/gas/orders/${order.orderRef}`,
      telegram: true,
    })
    return
  }

  // Lazy-load sender address from the payment tx if not already stored. Aptos
  // payments never carry a sender (poller stores a synthetic hash), so always
  // resolve via the indexer for those.
  // Manual refund: use the admin-specified destination directly (validated on the
  // settlement chain at the API boundary). Otherwise resolve the original payer.
  let senderAddress = toAddressOverride ?? order.paymentSenderAddress
  if (!senderAddress && order.paymentTxHash) {
    const txHash = order.paymentTxHash
    senderAddress = plan.kind === 'aptos'
      ? await getAptosSenderFromTx(txHash)
      : await getSenderAddressFromTx(plan.chain, txHash)
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
      void createAdminNotif({
        category: 'GAS',
        title: 'Gas Refund Failed — Sender Address Unresolvable',
        body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nPayment Tx: ${order.paymentTxHash}\n\nFailed to resolve sender address after ${maxAttempts} attempts. Manual refund required.`,
        href: `/admin/gas/orders/${order.orderRef}`,
        telegram: true,
      })
    }
    throw new Error('SENDER_ADDRESS_UNRESOLVABLE')
  }

  try {
    const refundTxHash = plan.kind === 'aptos'
      ? await sendAptosUsdtRefund(senderAddress, order.paymentAmount)
      : await sendUsdtRefund(plan.chain, senderAddress, order.paymentAmount)

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
      // Record the refund on the chain it actually left from. Aptos USDT is a
      // fungible-asset token outflow (no native APT moved) recorded via override.
      ...(plan.kind === 'aptos'
        ? {
            chain:        fromDbChain(order.chain),
            chainOverride: { dbChain: 'APT' as const, nativeSymbol: 'APT' },
            nativeAmount: 0,
            tokenSymbol:  'USDT',
            tokenAmount:  Number(order.paymentAmount),
          }
        : {
            chain:        plan.chain,
            nativeAmount: -Number(order.paymentAmount),
          }),
      usdAmount:      Number(order.paymentAmount),
      txHash:         refundTxHash,
      toAddress:      senderAddress,
      relatedOrderId: orderId,
      notes:          `USDT refund for order ${order.orderRef}${toAddressOverride ? ' (manual address)' : ''}`,
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
      void createAdminNotif({
        category: 'GAS',
        title: 'Gas Refund Failed After All Retries',
        body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nRefund to: ${senderAddress}\nAmount: ${order.paymentAmount} USDT\nError: ${errMsg}\n\nManual refund required.`,
        href: `/admin/gas/orders/${order.orderRef}`,
        telegram: true,
      })
    } else {
      throw err
    }
  }
}
