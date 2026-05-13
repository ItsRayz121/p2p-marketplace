import { Worker, type Processor } from 'bullmq'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { QUEUE_NAMES, queues } from './definitions'
import { updateRates } from '../jobs/rateUpdater.job'
import { runTradeEscalation } from '../jobs/tradeEscalation.job'
import { recalculateUserBadge } from '../jobs/badgeRecalculate.job'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorker(queueName: string, processor: Processor<any, any, string>) {
  const worker = new Worker(queueName, processor, {
    connection: redis,
    limiter: { max: 10, duration: 1000 },
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, queue: queueName, err, attemptsMade: job?.attemptsMade },
      `Job failed in queue: ${queueName}`,
    )

    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      // TODO: send admin alert email on final failure
      logger.error({ jobId: job.id, queue: queueName }, 'Job reached max retries — admin alert required')
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

  // Workers are registered here as job processors are built.
  // createWorker(QUEUE_NAMES.OCR, ...)
  // createWorker(QUEUE_NAMES.GAS_FEE, ...)
  // createWorker(QUEUE_NAMES.PUSH_NOTIFICATIONS, ...)
  // createWorker(QUEUE_NAMES.EMAIL_SENDER, ...)
  // createWorker(QUEUE_NAMES.REFERRAL_PAYOUT, ...)
  // createWorker(QUEUE_NAMES.FRAUD_DETECTOR, ...)
  // createWorker(QUEUE_NAMES.LEADERBOARD_CACHE, ...)
  // createWorker(QUEUE_NAMES.MERCHANT_RANK_UPDATER, ...)
  // createWorker(QUEUE_NAMES.DATABASE_BACKUP, ...)

  logger.info('BullMQ workers ready')
}

// Run as standalone process: npm run workers
if (require.main === module) {
  import('../lib/env')
  startWorkers()
  logger.info('Worker process started')
}
