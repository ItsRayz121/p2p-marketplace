import { Worker } from 'bullmq'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
// Import QUEUE_NAMES here when activating the first processor below

export function createWorker(queueName: string, processor: string) {
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

  // Workers are registered here as job processors are built.
  // Each worker points to a processor file in src/jobs/.
  //
  // createWorker(QUEUE_NAMES.OCR, require.resolve('../jobs/ocr.job'))
  // createWorker(QUEUE_NAMES.GAS_FEE, require.resolve('../jobs/gasFee/sendGas.job'))
  // createWorker(QUEUE_NAMES.PUSH_NOTIFICATIONS, require.resolve('../jobs/pushNotification.job'))
  // createWorker(QUEUE_NAMES.TRADE_ESCALATION, require.resolve('../jobs/tradeEscalation.job'))
  // createWorker(QUEUE_NAMES.BADGE_RECALCULATE, require.resolve('../jobs/badgeRecalculate.job'))
  // createWorker(QUEUE_NAMES.EMAIL_SENDER, require.resolve('../jobs/email.job'))
  // createWorker(QUEUE_NAMES.RATE_UPDATER, require.resolve('../jobs/rateUpdater.job'))
  // createWorker(QUEUE_NAMES.REFERRAL_PAYOUT, require.resolve('../jobs/referralPayout.job'))
  // createWorker(QUEUE_NAMES.FRAUD_DETECTOR, require.resolve('../jobs/fraudDetector.job'))
  // createWorker(QUEUE_NAMES.LEADERBOARD_CACHE, require.resolve('../jobs/leaderboardCache.job'))
  // createWorker(QUEUE_NAMES.MERCHANT_RANK_UPDATER, require.resolve('../jobs/merchantRankUpdater.job'))
  // createWorker(QUEUE_NAMES.DATABASE_BACKUP, require.resolve('../jobs/databaseBackup.job'))
  // createWorker(QUEUE_NAMES.GAS_FEE, require.resolve('../jobs/gasFee/expireOrder.job'))

  logger.info('BullMQ workers ready (no processors active yet — add them as features are built)')
}

// Run as standalone process: npm run workers
if (require.main === module) {
  import('../lib/env')
  startWorkers()
  logger.info('Worker process started')
}
