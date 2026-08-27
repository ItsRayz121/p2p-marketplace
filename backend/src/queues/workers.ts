import { Worker, type Processor } from 'bullmq'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { QUEUE_NAMES, queues } from './definitions'
import { scheduleSweep } from './scheduler'
import { processOcrVerification } from '../jobs/ocrVerification.job'
import { updateRates } from '../jobs/rateUpdater.job'
import { runTradeEscalation } from '../jobs/tradeEscalation.job'
import { recalculateUserBadge } from '../jobs/badgeRecalculate.job'
import { processReferralPayout } from '../jobs/referralPayout.job'
import { processGasFeeOrder, processGasDeliveryRetry, processGasAutoRefund } from '../jobs/gasFee.job'
import { runGasExpiryJob } from '../jobs/gasExpiry.job'
import { checkGasDelivery } from '../jobs/gasDeliveryCheck.job'
import { runGasMonitorBalances } from '../jobs/gasMonitorBalances.job'
import { processGasRefund } from '../jobs/gasRefund.job'
import { fireGasWebhook } from '../jobs/gasWebhook.job'
import { runRefillJob } from '../lib/gas/gas.refill'
import { runReconciliation } from '../lib/gas/gas.reconciliation'
import { runMerchantSettlementJob } from '../jobs/gasMerchantSettlement.job'
import { createAdminNotif } from '../services/adminNotification.service'
import { processSubscription } from '../services/moralisStreams.service'
import { runReconcileTick } from '../services/depositReconcile.service'
import { runCtmTradeExpiry, runCtmProofDeadline, runCtmDisputeEscalation, runCtmMerchantTierUpgrade, runCtmEscrowMonitor, runCtmInactiveMerchantPause, runCtmBidExpiry } from '../ctm/ctm.jobs'
import { runUsdtConfirmReminder, runUsdtConfirmDeadline } from '../jobs/usdtTradeDeadline.job'
import { runGasPaymentPoller } from '../jobs/gasPaymentPoller.job'
import { runAptosDepositPoller } from '../jobs/aptosDepositPoller.job'
import { runEvmDepositPoller } from '../jobs/evmDepositPoller.job'
import { runHotWalletDepositPoller } from '../jobs/gasHotWalletDepositPoller.job'
import { runWithdrawalConfirmationWatcher } from '../jobs/withdrawalConfirmationWatcher.job'
import { runModerationExpiry } from '../jobs/moderationExpiry.job'
import { runSupportIdleClose } from '../jobs/supportIdleClose.job'
import { runMediaRetention } from '../jobs/mediaRetention.job'
import { runAnnouncementBroadcast } from '../services/announcement.service'
import { env } from '../lib/env'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorker(queueName: string, processor: Processor<any, any, string>, options?: { max?: number; duration?: number }) {
  const worker = new Worker(queueName, processor, {
    connection: redis as any, // bullmq bundles its own ioredis — types diverge but runtime is compatible
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
      void createAdminNotif({
        category: 'SYSTEM',
        title: `Background job failed permanently: ${queueName}/${job.id}`,
        body: `Queue: ${queueName}\nJob ID: ${job.id}\nJob name: ${job.name}\nAttempts: ${job.attemptsMade}\nOrder ID: ${safeData.orderId}\nError: ${err?.message ?? 'Unknown error'}`,
        href: '/admin',
        telegram: true,
      })
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

  // Moderation expiry sweep — auto-lift elapsed suspensions / temp bans (every 60s).
  // Plain-interval sweep (see scheduler.ts) — ran with BullMQ attempts:1, so no
  // retry behavior is lost by moving it off the queue.
  scheduleSweep('moderation-expiry', runModerationExpiry, 60_000)

  // Active workers
  createWorker(QUEUE_NAMES.OCR, async (job) => {
    await processOcrVerification(job as Parameters<typeof processOcrVerification>[0])
  })

  createWorker(QUEUE_NAMES.RATE_UPDATER, async () => {
    await updateRates()
  })

  createWorker(QUEUE_NAMES.TRADE_ESCALATION, async () => {
    await runTradeEscalation()
  })

  // Support-chat idle-close sweep — auto-close conversations idle > 10 min so
  // the next user message starts a fresh session divider (every 60s).
  // Plain-interval sweep — ran with BullMQ attempts:1.
  scheduleSweep('support-idle-close', runSupportIdleClose, 60_000)

  // Media-retention sweep — daily. Purges payment proofs + trade-chat images for
  // long-settled trades to reclaim Cloudinary storage. Gated OFF by default
  // (`media_retention_enabled`); KYC media is never touched.
  // Plain-interval sweep — ran with BullMQ attempts:1.
  scheduleSweep('media-retention', () => runMediaRetention(), 24 * 60 * 60 * 1000)

  // Seed the retention config keys at startup (safe: gated OFF, so this only
  // creates `media_retention_enabled` / `media_retention_days` in Platform Config
  // for the admin to flip — it deletes nothing while disabled).
  void runMediaRetention().catch((err) => logger.error({ err }, 'Media-retention startup seed failed'))

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

  // Hot-wallet refill check — every 15 minutes. Plain-interval sweep — ran with
  // BullMQ attempts:1 (idempotent, no auto-retry on failure).
  scheduleSweep('gas-refill', runRefillJob, 15 * 60 * 1000)

  // Gas fee dispatcher — routes to the correct handler by job name.
  // Rate-limited to 2 concurrent to avoid TRON RPC saturation.
  createWorker(
    QUEUE_NAMES.GAS_FEE,
    async (job) => {
      switch (job.name) {
        case 'deliver':
          return processGasFeeOrder(job as Parameters<typeof processGasFeeOrder>[0])
        case 'retry-delivery':
          return processGasDeliveryRetry(job as Parameters<typeof processGasDeliveryRetry>[0])
        case 'auto-refund':
          return processGasAutoRefund(job as Parameters<typeof processGasAutoRefund>[0])
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
  // Plain-interval sweep — ran with BullMQ attempts:1.
  scheduleSweep('deposit-reconcile', runReconcileTick, env.DEPOSIT_RECONCILE_INTERVAL_SECONDS * 1000)

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

  // Gas reconciliation — runs daily at 02:00 UTC (every 24h from first fire).
  // Also backs the admin "trigger reconciliation now" button, which enqueues
  // a manual-trigger job with a chain payload — event-driven, stays on BullMQ.
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

  // CTM repeatable jobs. Expiry/proof-deadline/tier-upgrade/escrow-monitor/
  // inactive-pause/bid-expiry all ran with BullMQ attempts:1 — plain-interval
  // sweeps below. Dispute-escalation retains real BullMQ retry/backoff
  // (default attempts:3), so it stays a Queue+Worker.
  scheduleSweep('ctm-trade-expiry', runCtmTradeExpiry, 5 * 60 * 1000)
  scheduleSweep('ctm-proof-deadline', runCtmProofDeadline, 5 * 60 * 1000)

  // USDT final-confirmation deadline (crypto_sent stuck forever otherwise — see
  // usdtTradeDeadline.job.ts). Reminder at the halfway point, deadline sweep
  // matches CTM's 5-minute cadence.
  scheduleSweep('usdt-confirm-reminder', runUsdtConfirmReminder, 15 * 60 * 1000)
  scheduleSweep('usdt-confirm-deadline', runUsdtConfirmDeadline, 5 * 60 * 1000)

  queues.ctmDisputeEscalation
    .add('ctm-dispute-escalation', {}, { repeat: { every: 30 * 60 * 1000 }, jobId: 'ctm-dispute-escalation-repeatable' })
    .catch((err) => logger.error({ err }, 'Failed to schedule CTM dispute escalation job'))

  createWorker(QUEUE_NAMES.CTM_DISPUTE_ESCALATION, async () => { await runCtmDisputeEscalation() }, { max: 1, duration: 60_000 })

  scheduleSweep('ctm-tier-upgrade', runCtmMerchantTierUpgrade, 24 * 60 * 60 * 1000)
  scheduleSweep('ctm-escrow-monitor', runCtmEscrowMonitor, 5 * 60 * 1000)
  scheduleSweep('ctm-inactive-pause', runCtmInactiveMerchantPause, 6 * 60 * 60 * 1000)
  scheduleSweep('ctm-bid-expiry', runCtmBidExpiry, 5 * 60 * 1000)

  // Gas payment poller — fallback RPC-based detection when Moralis misses a webhook.
  // Cadence is operator-tunable via POLLER_INTERVAL_SECONDS (default 60s); it
  // skips quickly when no pending orders exist. Plain-interval sweep — ran with
  // BullMQ attempts:1.
  scheduleSweep('gas-payment-poller', runGasPaymentPoller, env.POLLER_INTERVAL_SECONDS * 1000)

  // Aptos USER deposit poller — credits inbound USDT to per-user Aptos deposit
  // addresses (the Aptos analogue of the EVM Moralis stream + reconciler).
  // Idempotent crediting makes the cadence safe; default 60s. Plain-interval
  // sweep — ran with BullMQ attempts:1.
  scheduleSweep('aptos-deposit-poller', runAptosDepositPoller, env.POLLER_INTERVAL_SECONDS * 1000)

  // EVM USER deposit poller — Moralis-independent backstop. Scans ERC20
  // Transfer logs to per-user deposit addresses via RPC and feeds hits through
  // the same idempotent processDepositEvent pipeline the webhook uses, so a
  // paused/broken Moralis stream can no longer silently swallow deposits.
  // Plain-interval sweep — ran with BullMQ attempts:1.
  scheduleSweep('evm-deposit-poller', runEvmDepositPoller, 2 * 60_000)

  // Hot-wallet deposit poller — runs every 2 minutes, detects direct balance
  // increases (top-ups) even when Moralis webhooks don't fire. Plain-interval
  // sweep — ran with BullMQ attempts:1.
  scheduleSweep('gas-hot-wallet-deposit-poll', runHotWalletDepositPoller, 2 * 60_000)

  // Withdrawal confirmation watcher — runs every 2 minutes, checks sent EVM
  // withdrawals for on-chain confirmation and alerts on reverted/stuck txs.
  // Plain-interval sweep — ran with BullMQ attempts:1.
  scheduleSweep('withdrawal-confirmation-watcher', runWithdrawalConfirmationWatcher, 2 * 60_000)

  // Announcement broadcast — one job per announcement; concurrency 1 so two
  // broadcasts never contend, and the job self-throttles Telegram internally.
  createWorker(
    QUEUE_NAMES.ANNOUNCEMENT_BROADCAST,
    async (job) => {
      const announcementId = (job.data as { announcementId?: string }).announcementId
      if (!announcementId) throw new Error('announcementId missing in job data')
      await runAnnouncementBroadcast(announcementId)
    },
    { max: 1, duration: 1000 },
  )

  logger.info('BullMQ workers ready')
}

// Run as standalone process: npm run workers
if (require.main === module) {
  void import('../lib/env')
  startWorkers()
  logger.info('Worker process started')
}
