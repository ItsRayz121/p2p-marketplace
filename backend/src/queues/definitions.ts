import { Queue } from 'bullmq'
import { redis } from '../lib/redis'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = redis as any

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
}

// Queue names — must match exactly in workers.ts and job files
export const QUEUE_NAMES = {
  OCR: 'ocr-verification',
  GAS_FEE: 'gas-fee',
  TRADE_ESCALATION: 'trade-escalation',
  BADGE_RECALCULATE: 'badge-recalculate',
  RATE_UPDATER: 'rate-updater',
  REFERRAL_PAYOUT: 'referral-payout',
  MORALIS_SUBSCRIBE: 'moralis-subscribe',
  GAS_WEBHOOK:              'gas-webhook',
  GAS_RECONCILIATION:       'gas-reconciliation',
  GAS_MERCHANT_SETTLEMENT:  'gas-merchant-settlement',
  CTM_DISPUTE_ESCALATION:   'ctm-dispute-escalation',
  ANNOUNCEMENT_BROADCAST:           'announcement-broadcast',
} as const

export const queues = {
  ocr: new Queue(QUEUE_NAMES.OCR, { connection, defaultJobOptions }),
  gasFee: new Queue(QUEUE_NAMES.GAS_FEE, { connection, defaultJobOptions: { ...defaultJobOptions, backoff: { type: 'exponential', delay: 10000 } } }),
  tradeEscalation: new Queue(QUEUE_NAMES.TRADE_ESCALATION, { connection, defaultJobOptions }),
  badgeRecalculate: new Queue(QUEUE_NAMES.BADGE_RECALCULATE, { connection, defaultJobOptions }),
  rateUpdater: new Queue(QUEUE_NAMES.RATE_UPDATER, { connection, defaultJobOptions }),
  referralPayout: new Queue(QUEUE_NAMES.REFERRAL_PAYOUT, { connection, defaultJobOptions }),
  moralisSubscribe: new Queue(QUEUE_NAMES.MORALIS_SUBSCRIBE, {
    connection,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 6, // a few extra to ride out longer Moralis outages
      backoff: { type: 'exponential', delay: 15_000 },
    },
  }),
  gasWebhook: new Queue(QUEUE_NAMES.GAS_WEBHOOK, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  }),
  // Also serves the admin "trigger reconciliation now" endpoint
  // (POST /admin/gas/reconciliation/trigger), which enqueues a manual-trigger
  // job with a `chain` payload rather than running inline — real event-driven
  // usage, not a pure sweep, so this stays on BullMQ.
  gasReconciliation: new Queue(QUEUE_NAMES.GAS_RECONCILIATION, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 1, removeOnComplete: { count: 30 }, removeOnFail: { count: 50 } },
  }),
  gasMerchantSettlement: new Queue(QUEUE_NAMES.GAS_MERCHANT_SETTLEMENT, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 2, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
  ctmDisputeEscalation: new Queue(QUEUE_NAMES.CTM_DISPUTE_ESCALATION, { connection, defaultJobOptions }),
  // Broadcast fan-out (bell + throttled Telegram). attempts:1 — a partial resend
  // would double-DM users, so we never auto-retry; failures are logged + alerted.
  announcementBroadcast: new Queue(QUEUE_NAMES.ANNOUNCEMENT_BROADCAST, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
}
