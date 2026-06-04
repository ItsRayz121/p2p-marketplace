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
  PUSH_NOTIFICATIONS: 'push-notifications',
  TRADE_ESCALATION: 'trade-escalation',
  BADGE_RECALCULATE: 'badge-recalculate',
  EMAIL_SENDER: 'email-sender',
  RATE_UPDATER: 'rate-updater',
  REFERRAL_PAYOUT: 'referral-payout',
  FRAUD_DETECTOR: 'fraud-detector',
  LEADERBOARD_CACHE: 'leaderboard-cache',
  MERCHANT_RANK_UPDATER: 'merchant-rank-updater',
  DATABASE_BACKUP: 'database-backup',
  MORALIS_SUBSCRIBE: 'moralis-subscribe',
  DEPOSIT_RECONCILE: 'deposit-reconcile',
  GAS_WEBHOOK:              'gas-webhook',
  GAS_REFILL:               'gas-refill',
  GAS_RECONCILIATION:       'gas-reconciliation',
  GAS_MERCHANT_SETTLEMENT:  'gas-merchant-settlement',
  CTM_EXPIRY:               'ctm-expiry',
  CTM_PROOF_DEADLINE:       'ctm-proof-deadline',
  CTM_DISPUTE_ESCALATION:   'ctm-dispute-escalation',
  CTM_TIER_UPGRADE:         'ctm-tier-upgrade',
  CTM_ESCROW_MONITOR:       'ctm-escrow-monitor',
  CTM_INACTIVE_PAUSE:       'ctm-inactive-pause',
  CTM_BID_EXPIRY:           'ctm-bid-expiry',
  GAS_PAYMENT_POLLER:               'gas-payment-poller',
  GAS_HOT_WALLET_DEPOSIT_POLL:      'gas-hot-wallet-deposit-poll',
  WITHDRAWAL_CONFIRMATION_WATCHER:  'withdrawal-confirmation-watcher',
} as const

export const queues = {
  ocr: new Queue(QUEUE_NAMES.OCR, { connection, defaultJobOptions }),
  gasFee: new Queue(QUEUE_NAMES.GAS_FEE, { connection, defaultJobOptions: { ...defaultJobOptions, backoff: { type: 'exponential', delay: 10000 } } }),
  pushNotifications: new Queue(QUEUE_NAMES.PUSH_NOTIFICATIONS, { connection, defaultJobOptions }),
  tradeEscalation: new Queue(QUEUE_NAMES.TRADE_ESCALATION, { connection, defaultJobOptions }),
  badgeRecalculate: new Queue(QUEUE_NAMES.BADGE_RECALCULATE, { connection, defaultJobOptions }),
  emailSender: new Queue(QUEUE_NAMES.EMAIL_SENDER, { connection, defaultJobOptions }),
  rateUpdater: new Queue(QUEUE_NAMES.RATE_UPDATER, { connection, defaultJobOptions }),
  referralPayout: new Queue(QUEUE_NAMES.REFERRAL_PAYOUT, { connection, defaultJobOptions }),
  fraudDetector: new Queue(QUEUE_NAMES.FRAUD_DETECTOR, { connection, defaultJobOptions }),
  leaderboardCache: new Queue(QUEUE_NAMES.LEADERBOARD_CACHE, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  merchantRankUpdater: new Queue(QUEUE_NAMES.MERCHANT_RANK_UPDATER, { connection, defaultJobOptions }),
  databaseBackup: new Queue(QUEUE_NAMES.DATABASE_BACKUP, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 2 } }),
  moralisSubscribe: new Queue(QUEUE_NAMES.MORALIS_SUBSCRIBE, {
    connection,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 6, // a few extra to ride out longer Moralis outages
      backoff: { type: 'exponential', delay: 15_000 },
    },
  }),
  // Reconciler ticks must not stack — if one tick is slow we'd rather skip
  // overlapping ticks than process the same candidate rows concurrently.
  // We achieve that via `jobId` on the repeatable job in workers.ts and by
  // capping attempts at 1 so retries don't double up.
  gasRefill: new Queue(QUEUE_NAMES.GAS_REFILL, {
    connection,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 1,  // refill job is idempotent — don't auto-retry on failure
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 200 },
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
  depositReconcile: new Queue(QUEUE_NAMES.DEPOSIT_RECONCILE, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
  gasReconciliation: new Queue(QUEUE_NAMES.GAS_RECONCILIATION, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 1, removeOnComplete: { count: 30 }, removeOnFail: { count: 50 } },
  }),
  gasMerchantSettlement: new Queue(QUEUE_NAMES.GAS_MERCHANT_SETTLEMENT, {
    connection,
    defaultJobOptions: { ...defaultJobOptions, attempts: 2, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
  ctmExpiry: new Queue(QUEUE_NAMES.CTM_EXPIRY, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  ctmProofDeadline: new Queue(QUEUE_NAMES.CTM_PROOF_DEADLINE, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  ctmDisputeEscalation: new Queue(QUEUE_NAMES.CTM_DISPUTE_ESCALATION, { connection, defaultJobOptions }),
  ctmTierUpgrade: new Queue(QUEUE_NAMES.CTM_TIER_UPGRADE, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  ctmEscrowMonitor: new Queue(QUEUE_NAMES.CTM_ESCROW_MONITOR, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  ctmInactivePause: new Queue(QUEUE_NAMES.CTM_INACTIVE_PAUSE, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  ctmBidExpiry: new Queue(QUEUE_NAMES.CTM_BID_EXPIRY, { connection, defaultJobOptions: { ...defaultJobOptions, attempts: 1 } }),
  gasPaymentPoller: new Queue(QUEUE_NAMES.GAS_PAYMENT_POLLER, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
  gasHotWalletDepositPoll: new Queue(QUEUE_NAMES.GAS_HOT_WALLET_DEPOSIT_POLL, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
  withdrawalConfirmationWatcher: new Queue(QUEUE_NAMES.WITHDRAWAL_CONFIRMATION_WATCHER, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  }),
}
