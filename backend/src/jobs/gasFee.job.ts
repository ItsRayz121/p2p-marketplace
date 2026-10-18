import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { deliverGas, describeDeliveryError } from '../lib/gas/gas.delivery'
import type { DeliveryJournal } from '../lib/gas/gas.delivery'
import { assessPriorAttempt } from '../lib/gas/gas.attemptSafety'
import { supportsAttemptJournal } from '../lib/gas/gas.attemptRules'
import { logger } from '../lib/logger'
import { queues } from '../queues/definitions'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { fromDbChain } from '../lib/gas/gas.chains'
import { selectHotWallet } from '../lib/gas/gasWalletService'
import { createAdminNotif } from '../services/adminNotification.service'
import { recordGasAudit } from '../lib/gas/gas.matching'
import { accrueReferralForDelivery } from '../lib/gas/gas.referral'
import { markShareRewardUsed } from '../lib/gas/gas.share'
import { awardGasPointsForDelivery } from '../services/airdrop.service'
import { REFUND_WINDOW_MS, AUTO_REFUND_SAFETY_MS, RETRY_INTERVAL_MS } from '../lib/gas/gas.refundWindow'
import { maybeSendTrustpilotReviewNudge } from '../services/trustpilotReview.service'
import { awaitTxInclusion, getTxStatus } from '../lib/gas/gas.confirmation'
import type { TxStatus } from '../lib/gas/gas.confirmation'
import type { GasFeeOrder } from '@prisma/client'

type HotWallet = Awaited<ReturnType<typeof selectHotWallet>> | null

// ── Shared success path ─────────────────────────────────────────────────────
// Marks the order delivered, writes the ledger entry, schedules the on-chain
// confirmation check, and fires notifications. Used by both the initial delivery
// (processGasFeeOrder) and the in-window retries (processGasDeliveryRetry), so a
// delivery that finally succeeds during the refund window is finalised identically.
async function finalizeDeliverySuccess(
  orderId: string,
  order: GasFeeOrder,
  deliveryTxHash: string,
  hotWallet: HotWallet,
): Promise<void> {
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: {
      status: 'delivered',
      deliveryTxHash,
      unconfirmedDeliveryTxHash: null,
      deliveryConfirmed: false,
      deliveredAt: new Date(),
      // Clear the refund window — delivery beat the clock.
      refundEligibleAt: null,
      fromHotWallet: hotWallet?.address ?? order.fromHotWallet,
    },
  })

  appendLedgerEntry({
    entryType:      'gas_delivery',
    // Aptos isn't in the GasChainId set — log it via chainOverride so the ledger
    // entry attributes correctly (token deliveries on Aptos, e.g. USDT/USDC).
    chain:          order.chain === 'APT' ? ('BSC' as GasChainId) : (fromDbChain(order.chain) as GasChainId),
    ...(order.chain === 'APT' ? { chainOverride: { dbChain: 'APT' as const, nativeSymbol: 'APT' } } : {}),
    nativeAmount:   -Number(order.gasAmountNative),
    usdAmount:      Number(order.gasAmountUSD),
    txHash:         deliveryTxHash,
    toAddress:      order.toAddress,
    relatedOrderId: orderId,
    notes:          `Delivery for order ${order.orderRef}`,
    ...(order.fromHotWallet ? { fromAddress: order.fromHotWallet } : {}),
  }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write delivery ledger entry'))

  // Enqueue on-chain confirmation check 60s after send (10 retries × 60s = 10 min window)
  await queues.gasFee.add(
    'check-delivery',
    { orderId, txHash: deliveryTxHash },
    {
      delay: 60_000,
      jobId: `gas-check-delivery-${orderId}`,
      attempts: 10,
      backoff: { type: 'fixed', delay: 60_000 },
    },
  )

  logger.info({ orderId, deliveryTxHash, chain: order.chain }, 'Gas fee delivered successfully')
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'delivered', txHash: deliveryTxHash, expectedChain: order.chain,
    detail: `Gas released: ${Number(order.gasAmountNative)} ${order.chain} → ${order.toAddress}`,
  })
  await notifyMerchantWebhook(orderId, 'delivered')
  // Gas referral: accrue the referrer's share of the realized margin (best-effort,
  // idempotent, no-op unless the flag is ON and the buyer is a bound referred user).
  await accrueReferralForDelivery(order).catch((e) => logger.warn({ err: e, orderId }, 'gas referral accrual failed'))
  await markShareRewardUsed(order)
  // Airdrop: award a flat point per delivered paid gas order (idempotent, no-op when off).
  await awardGasPointsForDelivery(order).catch((e) => logger.warn({ err: e, orderId }, 'airdrop gas award failed'))
  // Gas orders count toward user trade stats — trigger unified badge recalculate
  if (order.userId) {
    queues.badgeRecalculate.add('recalc', { userId: order.userId }).catch(() => {})
    void maybeSendTrustpilotReviewNudge(order.userId)
  }
  void createAdminNotif({
    category: 'GAS',
    title: `Gas Sent — ${Number(order.gasAmountNative).toFixed(6)} ${order.chain}`,
    body: `Order ${order.orderRef} delivered to ${order.toAddress.slice(0, 10)}… Tx: ${deliveryTxHash.slice(0, 12)}…`,
    href: `/admin/gas/orders/${order.orderRef}`,
    gasOrderId: order.id,
    metadata: { txHash: deliveryTxHash, orderId, chain: order.chain, toAddress: order.toAddress, amount: order.gasAmountNative },
  })
}

// ── On-chain gating ──────────────────────────────────────────────────────────
// A tx hash returned by an RPC node only proves the node ACCEPTED the broadcast, not
// that the chain mined it (nodes drop txs, or accept without propagating). So an order
// is only marked `delivered` — and the ledger / referral / airdrop / merchant-webhook
// side-effects only fire — once the chain confirms inclusion. Until then the order stays
// `sending` with the hash parked in unconfirmedDeliveryTxHash.
const INCLUSION_WAIT_MS = 90_000          // initial in-job wait for the tx to be mined
const INCLUSION_POLL_MS = 6_000
const VERIFY_INTERVAL_MS = 30_000         // follow-up polling cadence
const VERIFY_DROPPED_AFTER_MS = 5 * 60_000   // no node has ever seen the tx → dropped
const ETH_STUCK_AFTER_MS = 3 * 60_000
const VERIFY_GIVE_UP_MS = 20 * 60_000        // seen in a mempool but never mined

type BroadcastVerdict = 'confirmed' | 'failed' | 'wait'

/** Pure decision: what to do with a broadcast tx given its live status and age. */
export function decideBroadcastVerdict(status: TxStatus, ageMs: number, chain?: string): BroadcastVerdict {
  if (status.state === 'success') return 'confirmed'
  if (status.state === 'reverted') return 'failed'
  // Ethereum: blocks are 12s, so a tx unmined after ~3 min at the normal fee is stuck — tell the admin
  // early (Speed up / Cancel) instead of leaving it, and every later send, queued for 20 minutes.
  if (chain === 'ETH' && ageMs >= ETH_STUCK_AFTER_MS) return 'failed'
  if (status.state === 'not_found' && ageMs >= VERIFY_DROPPED_AFTER_MS) return 'failed'
  if (ageMs >= VERIFY_GIVE_UP_MS) return 'failed'
  return 'wait'
}

function describeUnconfirmed(txHash: string, status: TxStatus): string {
  const why = status.state === 'reverted'
    ? 'was mined but REVERTED on-chain (no gas was delivered)'
    : status.state === 'mempool'
      ? 'was seen by a node but never mined — it may STILL land'
      : 'was not seen on-chain — it may be dropped, but that is NOT proven and it may still land'
  return `delivery_unconfirmed: broadcast tx ${txHash} ${why}. Do NOT resend or refund until it is verified (admin: use "Verify on-chain"). Ethereum: use "Speed up" (re-sends the same payout with +11% fee, no double delivery) or "Cancel stuck tx". Retry is only allowed once the attempt is proven unable to land.`
}

/** Thrown when an earlier attempt exists that cannot be proven dead — automation must stop. */
class ManualReviewRequired extends Error {
  constructor(message: string) { super(message); this.name = 'ManualReviewRequired' }
}

/**
 * STRICT no-double-delivery policy. Automation sends gas for an order at most ONCE: as soon as
 * an attempt has been journaled/broadcast, any further send is a human decision (admin Retry
 * is itself gated on the earlier attempt being proven dead). A late-landed attempt is ADOPTED.
 */
async function sendOrAdopt(orderId: string, order: GasFeeOrder): Promise<{ txHash: string; hotWallet: HotWallet }> {
  const prior = await assessPriorAttempt(order)
  if (prior.verdict === 'landed' && prior.txHash) return { txHash: prior.txHash, hotWallet: null }
  if (prior.verdict !== 'none') {
    throw new ManualReviewRequired(`An earlier delivery attempt exists for this order — automatic resend is disabled. ${prior.detail}`)
  }
  const { hotWallet, hdIndex } = await pickHotWallet(orderId, order)
  // Written BEFORE the tx leaves the process: from here on the order may already be paid.
  const journal: DeliveryJournal = async (a) => {
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: {
        unconfirmedDeliveryTxHash: a.txHash,
        deliveryNonce: a.nonce ?? null,
        deliveryAttemptAt: new Date(),
        ...(a.from ? { fromHotWallet: a.from } : {}),
      },
    })
  }
  const txHash = await deliverGas(order, hdIndex, journal)
  return { txHash, hotWallet }
}

/**
 * Stop automation and surface the order as FAILED for a human decision. Never refunds and
 * never retries by itself: the earlier attempt may still land.
 */
async function markNeedsManual(orderId: string, order: GasFeeOrder, reason: string): Promise<void> {
  const moved = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'sending' },
    data: { status: 'failed', failureReason: reason.slice(0, 480), retryCount: { increment: 1 } },
  })
  if (moved.count === 0) return
  try { await queues.gasFee.remove(`gas-auto-refund-${orderId}`) } catch { /* non-fatal */ }
  logger.error({ orderId, chain: order.chain }, `Gas delivery needs manual review: ${reason}`)
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'needs_manual_review', expectedChain: order.chain, detail: reason,
  })
  await notifyMerchantWebhook(orderId, 'failed')
  void createAdminNotif({
    category: 'GAS',
    title: 'Gas Delivery Needs Manual Review — NOT auto-retried',
    body: `Order Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative}\n\n${reason}\n\nNothing will be resent or refunded automatically (to rule out a double delivery). Open the order: Verify on-chain, then Retry (only when proven safe), Manual deliver, or Refund.`,
    href: `/admin/gas/orders/${order.orderRef}`,
    gasOrderId: order.id,
    telegram: true,
  })
}

async function failUnconfirmedBroadcast(orderId: string, order: GasFeeOrder, txHash: string, status: TxStatus): Promise<void> {
  const msg = describeUnconfirmed(txHash, status)
  logger.error({ orderId, txHash, chain: order.chain, state: status.state }, 'Gas delivery tx not confirmed on-chain — order NOT marked delivered')
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'delivery_unconfirmed', txHash, expectedChain: order.chain, reason: status.state, detail: msg,
  })
  await markNeedsManual(orderId, order, msg)
}


// Park the broadcast, wait briefly for inclusion, then either finalize, fail, or hand
// over to the follow-up verifier. NEVER throws into the send/retry path (a throw there
// would re-send gas that may already be on its way).
async function settleBroadcast(orderId: string, order: GasFeeOrder, txHash: string, hotWallet: HotWallet): Promise<void> {
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: {
      unconfirmedDeliveryTxHash: txHash,
      fromHotWallet: hotWallet?.address ?? order.fromHotWallet,
    },
  })
  // Chains without a pre-broadcast journal get their attempt time here (never overwrite one).
  await db.gasFeeOrder.updateMany({ where: { id: orderId, deliveryAttemptAt: null }, data: { deliveryAttemptAt: new Date() } })
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'delivery_broadcast', txHash, expectedChain: order.chain,
    detail: 'Broadcast accepted by RPC — waiting for on-chain inclusion before marking delivered',
  })

  const status = await awaitTxInclusion(order.chain, txHash, { timeoutMs: INCLUSION_WAIT_MS, intervalMs: INCLUSION_POLL_MS })
  const verdict = decideBroadcastVerdict(status, INCLUSION_WAIT_MS, order.chain)
  if (verdict === 'confirmed') return finalizeDeliverySuccess(orderId, order, txHash, hotWallet)
  if (status.state === 'reverted') return failUnconfirmedBroadcast(orderId, order, txHash, status)

  // Not decided yet — keep the order in `sending` and keep checking in the background.
  await queues.gasFee.add(
    'verify-delivery',
    { orderId, txHash, startedAt: Date.now() - INCLUSION_WAIT_MS },
    { jobId: `gas-verify-${orderId}-${Date.now()}`, delay: VERIFY_INTERVAL_MS, attempts: 1 },
  )
}

// Background follow-up for a broadcast that was not mined inside the initial wait.
export async function processGasDeliveryVerify(job: Job<{ orderId: string; txHash: string; startedAt: number }>) {
  const { orderId, txHash, startedAt } = job.data
  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  // Stop if the order moved on (admin acted, already finalized) or a newer broadcast replaced this one.
  if (!order || order.status !== 'sending' || order.unconfirmedDeliveryTxHash !== txHash) return

  let status: TxStatus = { state: 'not_found' }
  try {
    status = await getTxStatus(order.chain, txHash)
  } catch (err) {
    logger.warn({ err, orderId, txHash }, 'Delivery verify: status lookup failed — will retry')
  }

  const ageMs = Date.now() - startedAt
  const verdict = decideBroadcastVerdict(status, ageMs, order.chain)
  if (verdict === 'confirmed') {
    const hotWallet = await selectHotWallet(order.chain).catch(() => null)
    await finalizeDeliverySuccess(orderId, order, txHash, hotWallet && hotWallet.address === order.fromHotWallet ? hotWallet : null)
    return
  }
  if (verdict === 'failed') {
    // A speed-up replaces the tx under the same nonce: an EARLIER hash of this order may be the one that landed.
    const prior = status.state === 'reverted' ? null : await assessPriorAttempt(order).catch(() => null)
    if (prior?.verdict === 'landed' && prior.txHash && prior.txHash !== txHash) {
      await db.gasFeeOrder.update({ where: { id: orderId }, data: { unconfirmedDeliveryTxHash: prior.txHash } })
      return finalizeDeliverySuccess(orderId, { ...order, unconfirmedDeliveryTxHash: prior.txHash }, prior.txHash, null)
    }
    return failUnconfirmedBroadcast(orderId, order, txHash, status)
  }

  await queues.gasFee.add(
    'verify-delivery',
    { orderId, txHash, startedAt },
    { jobId: `gas-verify-${orderId}-${Date.now()}`, delay: VERIFY_INTERVAL_MS, attempts: 1 },
  )
}

// Select the load-balanced hot wallet for the chain and stamp it on the order.
async function pickHotWallet(orderId: string, order: GasFeeOrder): Promise<{ hotWallet: HotWallet; hdIndex: number }> {
  const hotWallet = await selectHotWallet(order.chain).catch(() => null)
  if (hotWallet && hotWallet.address !== order.fromHotWallet) {
    await db.gasFeeOrder.update({ where: { id: orderId }, data: { fromHotWallet: hotWallet.address } })
  }
  return { hotWallet, hdIndex: hotWallet?.hdIndex ?? 0 }
}

// Schedule the next in-window delivery retry (single attempt). Unique jobId per
// scheduling so the linear retry chain isn't swallowed by jobId dedup.
async function scheduleDeliveryRetry(orderId: string): Promise<void> {
  await queues.gasFee.add(
    'retry-delivery',
    { orderId },
    { jobId: `gas-retry-${orderId}-${Date.now()}`, delay: RETRY_INTERVAL_MS, attempts: 1 },
  )
}

export async function processGasFeeOrder(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  // Respect the global pause switch — requeue with backoff if paused.
  const globalPause = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
  if (globalPause?.value === '1') {
    logger.warn({ orderId }, 'Gas delivery skipped — global pause is active')
    throw new Error('Gas delivery globally paused — will retry')
  }

  // DB-level CAS: atomically claim the order by transitioning payment_detected → sending.
  // If another worker process already claimed it, updateMany returns count=0 and we exit
  // immediately — no double-send is possible even under concurrent retries.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'payment_detected' },
    data: { status: 'sending' },
  })

  if (claimed.count === 0) {
    logger.info({ orderId }, 'Gas order already claimed or not in payment_detected — skipping')
    return
  }

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'Gas fee order not found after status claim — this should not happen')
    return
  }

  let sent: { txHash: string; hotWallet: HotWallet } | null = null
  try {
    sent = await sendOrAdopt(orderId, order)
  } catch (err) {
    const attemptNumber = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? 3
    const rawErrMsg = err instanceof Error ? err.message : String(err)
    // Normalize the raw provider/RPC error (e.g. "Request failed with status code
    // 500", or SUI "No valid gas coins found") into an actionable reason +
    // recommended action for the admin. We branch on the NORMALIZED code so
    // chain-specific phrasings (SUI/SOL empty-wallet errors that carry no .code)
    // are still recognised as insufficient balance.
    if (err instanceof ManualReviewRequired) return markNeedsManual(orderId, order, err.message)
    const normalized = describeDeliveryError(order.chain, err)
    const errMsg = normalized.message

    logger.error({ orderId, attempt: attemptNumber, code: normalized.code, err: rawErrMsg, chain: order.chain }, 'Gas fee delivery failed')
    await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
      source: 'worker', event: 'delivery_failed', expectedChain: order.chain,
      reason: normalized.code, detail: `attempt ${attemptNumber}/${maxAttempts}: ${normalized.reason}. Action: ${normalized.action}. (raw: ${rawErrMsg.slice(0, 200)})`,
    })

    // Insufficient hot wallet balance — don't burn retries on a tx that can't succeed.
    // Reset to payment_detected, alert admin, and let the refill job replenish the wallet
    // before the next delivery attempt is scheduled via the balance monitor.
    if (normalized.code === 'INSUFFICIENT_HOT_WALLET_BALANCE') {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected', failureReason: errMsg },
      })
      void createAdminNotif({
        category: 'GAS',
        title: `Gas Delivery Paused — Insufficient Hot Wallet Balance`,
        body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\n\nThe hot wallet does not have enough native balance to deliver this order. A refill request should be raised. Delivery will resume once the balance is restored.\n\nError: ${errMsg}`,
        href: `/admin/gas/orders/${order.orderRef}`,
        gasOrderId: order.id,
        telegram: true,
      })
      return
    }

    // Chains with no pre-broadcast journal: an error may hide an already-accepted broadcast,
    // so never auto-retry — a human decides (Verify on-chain → Retry / Manual deliver).
    if (!supportsAttemptJournal(order.chain)) {
      return markNeedsManual(orderId, order, `${errMsg} (${order.chain}: outcome of the send is not provable, so it is not retried automatically)`)
    }

    if (attemptNumber >= maxAttempts) {
      await enterRefundWindow(orderId, order, errMsg, maxAttempts)
    } else {
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { retryCount: attemptNumber },
      })
      // Re-open status to payment_detected so the next BullMQ retry can claim it via CAS
      await db.gasFeeOrder.update({
        where: { id: orderId },
        data: { status: 'payment_detected' },
      })
      throw err
    }
  }

  // Past this point gas has been broadcast: never throw back into the retry path.
  if (!sent) return
  const txHash = sent.txHash
  await settleBroadcast(orderId, order, txHash, sent.hotWallet).catch((e) =>
    logger.error({ err: e, orderId, txHash }, 'settleBroadcast failed — order left in sending for the stuck-order detector'))
}

// ── Refund window ────────────────────────────────────────────────────────────
// Initial delivery has exhausted its attempts. Rather than refund instantly, a
// PAID order enters `awaiting_refund`: we keep retrying delivery for a few minutes
// (a flaky RPC may recover), the UI shows a countdown, and the user may request an
// immediate refund once REFUND_WINDOW_MS elapses. A safety-net auto-refund fires at
// AUTO_REFUND_SAFETY_MS so funds are never left stuck. An UNPAID order just fails.
async function enterRefundWindow(orderId: string, order: GasFeeOrder, errMsg: string, maxAttempts: number): Promise<void> {
  if (!order.paymentTxHash) {
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'failed', failureReason: errMsg, retryCount: maxAttempts },
    })
    await notifyMerchantWebhook(orderId, 'failed')
    void createAdminNotif({
      category: 'GAS',
      title: `Gas Fee Delivery Failed After ${maxAttempts} Attempts`,
      body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\nNext status: failed (no payment on record)`,
      href: `/admin/gas/orders/${order.orderRef}`,
      gasOrderId: order.id,
      telegram: true,
    })
    return
  }

  const refundEligibleAt = new Date(Date.now() + REFUND_WINDOW_MS)
  await db.gasFeeOrder.update({
    where: { id: orderId },
    data: { status: 'awaiting_refund', failureReason: errMsg, retryCount: maxAttempts, refundEligibleAt },
  })

  // Keep trying to deliver during the window…
  await scheduleDeliveryRetry(orderId)
  // …and arm the safety-net auto-refund if the user never asks for one.
  await queues.gasFee.add(
    'auto-refund',
    { orderId },
    { jobId: `gas-auto-refund-${orderId}`, delay: AUTO_REFUND_SAFETY_MS, attempts: 1 },
  )

  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'awaiting_refund', expectedChain: order.chain,
    detail: `Delivery failed after ${maxAttempts} attempts — still retrying; refund available at ${refundEligibleAt.toISOString()}`,
  })
  await notifyMerchantWebhook(orderId, 'awaiting_refund')
  void createAdminNotif({
    category: 'GAS',
    title: `Gas Fee Delivery Failed — Awaiting Refund Window`,
    body: `Order ID: ${orderId}\nOrder Ref: ${order.orderRef}\nChain: ${order.chain}\nTo: ${order.toAddress}\nAmount: ${order.gasAmountNative} ${order.chain}\nError: ${errMsg}\n\nThe system will keep retrying delivery for ${Math.round(REFUND_WINDOW_MS / 60000)} min. The user can request a refund after that; an automatic refund fires at ${Math.round(AUTO_REFUND_SAFETY_MS / 60000)} min if not delivered.`,
    href: `/admin/gas/orders/${order.orderRef}`,
    gasOrderId: order.id,
    telegram: true,
  })
}

// In-window delivery retry. Single attempt; on failure it reverts to
// awaiting_refund (preserving refundEligibleAt) and reschedules itself until the
// order is delivered, refunded, or the safety-net deadline is reached.
export async function processGasDeliveryRetry(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order) return
  // Stop the chain if the order left the holding state (delivered, or a refund
  // was claimed by the user / auto-refund job).
  if (order.status !== 'awaiting_refund') return

  // Past the safety-net deadline? Stop retrying; the auto-refund job takes over.
  // refundEligibleAt = failureTime + REFUND_WINDOW_MS, so failureTime is derivable.
  if (order.refundEligibleAt) {
    const failureTime = new Date(order.refundEligibleAt).getTime() - REFUND_WINDOW_MS
    if (Date.now() - failureTime >= AUTO_REFUND_SAFETY_MS) return
  }

  // Don't attempt during a global pause — just reschedule.
  const globalPause = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
  if (globalPause?.value === '1') {
    await scheduleDeliveryRetry(orderId)
    return
  }

  // CAS claim: awaiting_refund → sending. Races the user button and the auto-refund
  // job (both do awaiting_refund → refund_pending); only one transition can win, so
  // we never deliver an order that's already being refunded.
  const claimed = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'awaiting_refund' },
    data: { status: 'sending' },
  })
  if (claimed.count === 0) return

  const fresh = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!fresh) return

  let sent: { txHash: string; hotWallet: HotWallet } | null = null
  try {
    sent = await sendOrAdopt(orderId, fresh)
  } catch (err) {
    if (err instanceof ManualReviewRequired) return markNeedsManual(orderId, fresh, err.message)
    const rawErrMsg = err instanceof Error ? err.message : String(err)
    const normalized = describeDeliveryError(fresh.chain, err)
    if (!supportsAttemptJournal(fresh.chain) && normalized.code !== 'INSUFFICIENT_HOT_WALLET_BALANCE') {
      return markNeedsManual(orderId, fresh, `${normalized.message} (${fresh.chain}: outcome not provable — not retried automatically)`)
    }
    // Revert to the holding state — keep the original refundEligibleAt so the
    // user's countdown isn't reset by each retry.
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'awaiting_refund', failureReason: normalized.message },
    })
    await recordGasAudit({ orderId, ...(fresh.paymentTxHash ? { txHash: fresh.paymentTxHash } : {}) }, {
      source: 'worker', event: 'delivery_failed', expectedChain: fresh.chain,
      reason: normalized.code, detail: `retry during refund window: ${normalized.reason}. (raw: ${rawErrMsg.slice(0, 200)})`,
    })
    await scheduleDeliveryRetry(orderId)
    return
  }

  if (!sent) return
  const txHash = sent.txHash
  await settleBroadcast(orderId, fresh, txHash, sent.hotWallet).catch((e) =>
    logger.error({ err: e, orderId, txHash }, 'settleBroadcast failed — order left in sending for the stuck-order detector'))
}

// Safety-net automatic refund. Fires AUTO_REFUND_SAFETY_MS after a delivery failure
// if the order is STILL awaiting_refund (i.e. neither delivered nor user-refunded).
// Transitions awaiting_refund → refund_pending and hands off to the refund job.
export async function processGasAutoRefund(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
  if (!order || order.status !== 'awaiting_refund') return // delivered or already refunding

  const moved = await db.gasFeeOrder.updateMany({
    where: { id: orderId, status: 'awaiting_refund' },
    data: { status: 'refund_pending' },
  })
  if (moved.count === 0) return

  await queues.gasFee.add(
    'process-refund',
    { orderId },
    { jobId: `gas-refund-${orderId}`, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
  )
  await recordGasAudit({ orderId, ...(order.paymentTxHash ? { txHash: order.paymentTxHash } : {}) }, {
    source: 'worker', event: 'refund_pending', expectedChain: order.chain,
    detail: 'Auto-refund safety net: delivery still not completed — refunding USDT',
  })
  await notifyMerchantWebhook(orderId, 'refund_pending')
  logger.info({ orderId }, 'Gas order auto-refund (safety net) triggered')
}
