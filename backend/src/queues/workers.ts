import { Worker, type Processor } from 'bullmq'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { QUEUE_NAMES, queues } from './definitions'
import { updateRates } from '../jobs/rateUpdater.job'
import { runTradeEscalation } from '../jobs/tradeEscalation.job'
import { recalculateUserBadge } from '../jobs/badgeRecalculate.job'
import { processReferralPayout } from '../jobs/referralPayout.job'
import { processGasFeeOrder } from '../jobs/gasFee.job'
import { runGasExpiryJob } from '../jobs/gasExpiry.job'
import { checkGasDelivery } from '../jobs/gasDeliveryCheck.job'
import { runGasMonitorBalances } from '../jobs/gasMonitorBalances.job'
import { processGasRefund } from '../jobs/gasRefund.job'
import { fireGasWebhook } from '../jobs/gasWebhook.job'
import { runRefillJob } from '../lib/gas/gas.refill'
import { runReconciliation } from '../lib/gas/gas.reconciliation'
import { runMerchantSettlementJob } from '../jobs/gasMerchantSettlement.job'
import { sendAdminAlertEmail } from '../services/email.service'
import { processSubscription } from '../services/moralisStreams.service'
import { runReconcileTick } from '../services/depositReconcile.service'
import { runCtmTradeExpiry, runCtmProofDeadline, runCtmDisputeEscalation } from '../ctm/ctm.jobs'
import { env } from '../lib/env'

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
      // Only include safe, non-sensitive fields from job.data in the alert email.
      // Never serialize the full data object — it may contain private keys or credentials.
      const safeData = { orderId: (job.data as Record<string, unknown>)?.orderId ?? '(none)' }
      sendAdminAlertEmail(
        `Background job failed permanently: ${queueName}/${job.id}`,
        `Queue: ${queueName}\nJob ID: ${job.id}\nJob name: ${job.name}\nAttempts: ${job.attemptsMade}\nOrder ID: ${safeData.orderId}\nError: ${err?.message ?? 'Unknown error'}`,
      ).catch((emailErr) => logger.warn({ emailErr, jobId: job.id, queue: queueName }, 'Failed to send permanent-failure alert email'))
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

  // Gas fee repeatable jobs
  queues.gasFee
    .add('expire-sweep', {}, { repeat: { every: 60_000 }, jobId: 'gas-expire-sweep-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule gas expiry sweep'))

  queues.gasFee
    .add('monitor-balances', {}, { repeat: { every: 5 * 60 * 1000 }, jobId: 'gas-monitor-balances-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule gas balance monitor'))

  // Hot-wallet refill check — every 15 minutes
  queues.gasRefill
    .add('refill-check', {}, { repeat: { every: 15 * 60 * 1000 }, jobId: 'gas-refill-check-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule gas refill check'))

  createWorker(QUEUE_NAMES.GAS_REFILL, async () => {
    await runRefillJob()
  }, { max: 1, duration: 60_000 })

  // Gas fee dispatcher — routes to the correct handler by job name.
  // Rate-limited to 2 concurrent to avoid TRON RPC saturation.
  createWorker(
    QUEUE_NAMES.GAS_FEE,
    async (job) => {
      switch (job.name) {
        case 'deliver':
          return processGasFeeOrder(job as Parameters<typeof processGasFeeOrder>[0])
        case 'expire-order':
        case 'expire-sweep':
          return runGasExpiryJob(job as Parameters<typeof runGasExpiryJob>[0])
        case 'check-delivery':
          return checkGasDelivery(job as Parameters<typeof checkGasDelivery>[0])
        case 'monitor-balances':
          return runGasMonitorBalances()
        case 'process-refund':
          return processGasRefund(job as Parameters<typeof processGasRefund>[0])
        default:
          logger.warn({ jobName: job.name }, 'Unknown gas fee job name — skipping')
      }
    },
    { max: 2, duration: 1000 },
  )

  // Merchant webhook dispatcher
  createWorker(
    QUEUE_NAMES.GAS_WEBHOOK,
    async (job) => {
      await fireGasWebhook(job as Parameters<typeof fireGasWebhook>[0])
    },
    { max: 10, duration: 1000 },
  )

  // Deposit reconciler: defence-in-depth against missed Moralis Stream events.
  // Repeats every DEPOSIT_RECONCILE_INTERVAL_SECONDS (default 60s).
  const reconcileIntervalMs = env.DEPOSIT_RECONCILE_INTERVAL_SECONDS * 1000
  queues.depositReconcile
    .add('tick', {}, { repeat: { every: reconcileIntervalMs }, jobId: 'deposit-reconcile-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule deposit-reconcile repeatable job'))

  createWorker(
    QUEUE_NAMES.DEPOSIT_RECONCILE,
    async () => {
      await runReconcileTick()
    },
    { max: 1, duration: 1000 },
  )

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

  // Gas reconciliation — runs daily at 02:00 UTC (every 24h from first fire)
  queues.gasReconciliation
    .add('daily-recon', {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'gas-recon-daily-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule gas reconciliation daily job'))

  createWorker(
    QUEUE_NAMES.GAS_RECONCILIATION,
    async () => { await runReconciliation() },
    { max: 1, duration: 60_000 },
  )

  // Merchant settlement — runs daily
  queues.gasMerchantSettlement
    .add('daily-settlements', {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'gas-merchant-settlement-daily' })
    .catch((err) => logger.error({ err }, 'Failed to schedule merchant settlement daily job'))

  createWorker(
    QUEUE_NAMES.GAS_MERCHANT_SETTLEMENT,
    async () => { await runMerchantSettlementJob() },
    { max: 1, duration: 60_000 },
  )

  // CTM repeatable jobs
  queues.ctmExpiry
    .add('ctm-trade-expiry', {}, { repeat: { every: 5 * 60 * 1000 }, jobId: 'ctm-trade-expiry-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule CTM trade expiry job'))

  queues.ctmProofDeadline
    .add('ctm-proof-deadline', {}, { repeat: { every: 5 * 60 * 1000 }, jobId: 'ctm-proof-deadline-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule CTM proof deadline job'))

  queues.ctmDisputeEscalation
    .add('ctm-dispute-escalation', {}, { repeat: { every: 30 * 60 * 1000 }, jobId: 'ctm-dispute-escalation-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule CTM dispute escalation job'))

  createWorker(QUEUE_NAMES.CTM_EXPIRY, async () => { await runCtmTradeExpiry() }, { max: 1, duration: 60_000 })
  createWorker(QUEUE_NAMES.CTM_PROOF_DEADLINE, async () => { await runCtmProofDeadline() }, { max: 1, duration: 60_000 })
  createWorker(QUEUE_NAMES.CTM_DISPUTE_ESCALATION, async () => { await runCtmDisputeEscalation() }, { max: 1, duration: 60_000 })

  logger.info('BullMQ workers ready')
}

// Run as standalone process: npm run workers
if (require.main === module) {
  void import('../lib/env')
  startWorkers()
  logger.info('Worker process started')
}
