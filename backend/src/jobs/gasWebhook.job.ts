import type { Job } from 'bullmq'
import { createHmac } from 'node:crypto'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

const WEBHOOK_TIMEOUT_MS = 10_000

export async function fireGasWebhook(job: Job<{ orderId: string; status: string }>) {
  const { orderId, status } = job.data

  const order = await db.gasFeeOrder.findUnique({
    where: { id: orderId },
    select: {
      orderRef:        true,
      chain:           true,
      tier:            true,
      gasAmountNative: true,
      paymentAmount:   true,
      toAddress:       true,
      deliveryTxHash:  true,
      refundTxHash:    true,
      status:          true,
      merchantApiKeyId: true,
    },
  })

  if (!order?.merchantApiKeyId) return // no merchant key — nothing to do

  const apiKey = await db.merchantApiKey.findUnique({
    where: { id: order.merchantApiKeyId },
    select: { webhookUrl: true, webhookSecret: true, isActive: true },
  })

  if (!apiKey?.webhookUrl || !apiKey.isActive) return

  const payload = JSON.stringify({
    event:           'gas_order.status_changed',
    orderRef:        order.orderRef,
    status,
    chain:           order.chain,
    tier:            order.tier,
    gasAmountNative: order.gasAmountNative,
    paymentAmount:   order.paymentAmount,
    toAddress:       order.toAddress,
    deliveryTxHash:  order.deliveryTxHash ?? null,
    refundTxHash:    order.refundTxHash ?? null,
    timestamp:       new Date().toISOString(),
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent':   'RupChain-Webhook/1.0',
    'X-Attempt':    String(job.attemptsMade + 1),
  }

  if (apiKey.webhookSecret) {
    const sig = createHmac('sha256', apiKey.webhookSecret).update(payload).digest('hex')
    headers['X-RupChain-Signature'] = `sha256=${sig}`
  }

  const controller = new AbortController()
  const timeoutId  = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)

  try {
    const res = await fetch(apiKey.webhookUrl, {
      method:  'POST',
      headers,
      body:    payload,
      signal:  controller.signal,
    })

    if (!res.ok) {
      logger.warn(
        { orderId, status, webhookUrl: apiKey.webhookUrl, httpStatus: res.status },
        'Merchant webhook returned non-2xx — will retry',
      )
      throw new Error(`Webhook HTTP ${res.status}`)
    }

    logger.info({ orderId, status, webhookUrl: apiKey.webhookUrl }, 'Merchant webhook delivered')
  } finally {
    clearTimeout(timeoutId)
  }
}
