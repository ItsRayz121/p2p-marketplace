import { Worker, type Processor } from 'bullmq'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { QUEUE_NAMES, queues } from './definitions'
import { updateRates } from '../jobs/rateUpdater.job'
import { runTradeEscalation } from '../jobs/tradeEscalation.job'
import { recalculateUserBadge } from '../jobs/badgeRecalculate.job'
import { processReferralPayout } from '../jobs/referralPayout.job'
import { sendAdminAlertEmail } from '../services/email.service'
import { processSubscription } from '../services/moralisStreams.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorker(queueName: string, processor: Processor<any, any, string>, options?: { max?: number; duration?: number }) {
  const worker = new Worker(queueName, processor, {
    connection: redis,
    limiter: { max: options?.max ?? 10, duration: options?.duration ?? 1000 },
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: queueName, err, attemptsMade: job?.attemptsMade },
      `Job failed in queue: ${queueName}`,
    )

    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      sendAdminAlertEmail(
        `Background job failed permanently: ${queueName}/${job.id}`,
        `Queue: ${queueName}\nJob ID: ${job.id}\nAttempts: ${job.attemptsMade}\nData: ${JSON.stringify(job.data)}\nError: ${err?.message ?? 'Unknown error'}`,
      ).catch(() => {})
    }
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, queue: queueName }, 'Job completed')
  })

  return worker
}

export function startWorkers() {
  logger.info('Starting BullMQ workers...')

  // Rate updater repeatable job (every 5 minutes)
  queues.rateUpdater.add('update-rates', {}, { repeat: { every: 5 * 60 * 1000 } }).catch((err) =>
    logger.error({ err }, 'Failed to schedule rate-updater repeatable job'),
  )

  // Trade escalation repeatable job (every 30 minutes)
  queues.tradeEscalation
    .add('escalate', {}, { repeat: { every: 30 * 60 * 1000 } })
    .catch((err) =>
      logger.error({ err }, 'Failed to schedule trade-escalation repeatable job'),
    )

  // Active workers
  createWorker(QUEUE_NAMES.RATE_UPDATER, async () => {
    await updateRates()
  })

  createWorker(QUEUE_NAMES.TRADE_ESCALATION, async () => {
    await runTradeEscalation()
  })

  createWorker(QUEUE_NAMES.BADGE_RECALCULATE, async (job) => {
    await recalculateUserBadge(job.data.userId as string)
  })

  createWorker(QUEUE_NAMES.REFERRAL_PAYOUT, async (job) => {
    await processReferralPayout(job)
  })

  // Moralis Streams subscriber. Conservative rate limit — Moralis free-tier
  // accepts a few RPS comfortably. If the result says `retryable`, throw so
  // BullMQ schedules an exponential-backoff retry; otherwise return normally.
  createWorker(
    QUEUE_NAMES.MORALIS_SUBSCRIBE,
    async (job) => {
      const subscriptionId = (job.data as { subscriptionId?: string }).subscriptionId
      if (!subscriptionId) throw new Error('subscriptionId missing in job data')
      const result = await processSubscription(subscriptionId)
      if (result.retryable) {
        throw new Error('moralis_subscription_retryable')
      }
    },
    { max: 3, duration: 1000 }, // 3 req/sec ceiling
  )

  logger.info('BullMQ workers ready')
}

// Run as standalone process: npm run workers
if (require.main === module) {
  void import('../lib/env')
  startWorkers()
  logger.info('Worker process started')
}
