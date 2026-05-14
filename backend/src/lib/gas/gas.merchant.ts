import { queues } from '../../queues/definitions'
import { logger } from '../logger'

/**
 * Enqueue a merchant webhook notification if the gas order was placed via a
 * merchant API key. Safe to call unconditionally — no-ops if no key is set.
 */
export async function notifyMerchantWebhook(orderId: string, status: string): Promise<void> {
  try {
    await queues.gasWebhook.add(
      'fire',
      { orderId, status },
      {
        jobId:    `webhook-${orderId}-${status}`,
        attempts: 4,
        backoff:  { type: 'exponential', delay: 15_000 },
      },
    )
  } catch (err) {
    // Webhook dispatch is best-effort — never let it block the primary gas flow
    logger.warn({ orderId, status, err }, 'notifyMerchantWebhook: failed to enqueue — ignoring')
  }
}
