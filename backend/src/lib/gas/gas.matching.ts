// Shared gas-payment attribution + auto-delivery.
//
// This is the single source of truth for "an on-chain USDT payment arrived —
// which order does it belong to, and should we release gas?". It is called from:
//   - gasPaymentPoller.job.ts (RPC getLogs / TronGrid / Aptos indexer)
//   - webhook.routes.ts        (Moralis Streams ERC20 events)
//
// Both detection paths MUST use identical attribution logic so a payment can
// never be credited differently depending on which path saw it first. Every
// decision is written to a per-order (or per-tx, when unmatched) audit journal
// so admins can see exactly why an order did or didn't auto-release.

import { db } from '../prisma'
import { redis } from '../redis'
import { logger } from '../logger'
import { queues } from '../../queues/definitions'
import { sendAdminAlertEmail } from '../../services/email.service'
import { createAdminNotif } from '../../services/adminNotification.service'
import { appendLedgerEntry } from './gas.ledger'
import { fromDbChain, paymentNetworkSettlementChain } from './gas.chains'
import type { GasChainId } from './gas.chains'

// Orders carry a UNIQUE paymentAmount (assigned on a 0.001 grid). An incoming
// payment within this epsilon of an order's amount is an exact, unambiguous match.
// Must be < half the 0.001 grid step so adjacent unique amounts never overlap.
export const EXACT_MATCH_EPSILON = 0.0004

// ── Per-order / per-tx audit journal (Redis-backed, no schema migration) ────────
// Stored as a capped list so the order-detail endpoint can render the full
// lifecycle: expected vs detected, match pass, rejection reason, confirmations,
// and the release attempt result.

export interface GasAuditEvent {
  ts: string
  source: 'poller' | 'webhook' | 'worker' | 'admin'
  event: string                 // e.g. 'detected', 'matched', 'rejected', 'delivery_queued'
  paymentNetwork?: string
  txHash?: string
  detectedAmount?: number
  detectedAsset?: string
  fromAddress?: string
  toAddress?: string
  expectedAmount?: number
  expectedChain?: string
  matchPass?: string            // 'tx_hash' | 'exact' | 'tolerant' | 'grace'
  confirmations?: number
  reason?: string               // rejection / parking reason
  detail?: string
}

function orderAuditKey(orderId: string) { return `gas:order_audit:${orderId}` }
function txAuditKey(txHash: string)     { return `gas:tx_audit:${txHash}` }

// Append an audit event. Best-effort — an audit write must never break matching.
export async function recordGasAudit(target: { orderId?: string; txHash?: string }, ev: Omit<GasAuditEvent, 'ts'>): Promise<void> {
  const entry: GasAuditEvent = { ts: new Date().toISOString(), ...ev }
  const payload = JSON.stringify(entry)
  try {
    if (target.orderId) {
      const k = orderAuditKey(target.orderId)
      await redis.lpush(k, payload)
      await redis.ltrim(k, 0, 99)
      await redis.expire(k, 60 * 60 * 24 * 60) // 60 days
    }
    if (target.txHash) {
      const k = txAuditKey(target.txHash)
      await redis.lpush(k, payload)
      await redis.ltrim(k, 0, 49)
      await redis.expire(k, 60 * 60 * 24 * 30) // 30 days
    }
  } catch {
    /* best-effort */
  }
}

// Read an order's audit journal (newest first), for the admin order-detail page.
export async function getGasAudit(orderId: string): Promise<GasAuditEvent[]> {
  try {
    const raw = await redis.lrange(orderAuditKey(orderId), 0, 99)
    return raw.map((r) => { try { return JSON.parse(r) as GasAuditEvent } catch { return null } })
      .filter((x): x is GasAuditEvent => x !== null)
  } catch {
    return []
  }
}

export interface MatchResult {
  matched: boolean
  orderId?: string
  orderRef?: string
  reason?: string   // when not matched: ambiguous_* | poller_no_match | duplicate
}

export interface MatchParams {
  paymentNetwork: string
  txHash: string
  incoming: number
  confirmations: number
  senderAddress?: string
  depositAddress: string
  graceCutoff: Date
  source: 'poller' | 'webhook'
  getBlockTimestampMs: () => Promise<number | null>
}

// Applies the 4-pass attribution and queues delivery on a confirmed match.
// Returns { matched } so callers (e.g. the webhook) can decide whether to also
// record the transfer as an external hot-wallet deposit fallback.
export async function matchAndDeliverGasPayment(p: MatchParams): Promise<MatchResult> {
  const { paymentNetwork, txHash, incoming, confirmations, senderAddress, depositAddress, graceCutoff, source } = p

  // Duplicate guard: skip if already attributed to an order past the verification
  // stage. We must NOT skip payment_uploaded orders whose paymentTxHash was set by
  // the user submitting proof — those are exactly what Pass 1 handles.
  const alreadyUsed = await db.gasFeeOrder.findFirst({
    where: { paymentTxHash: txHash, status: { notIn: ['payment_uploaded'] } },
  })
  if (alreadyUsed) {
    await recordGasAudit({ orderId: alreadyUsed.id, txHash }, {
      source, event: 'duplicate_skipped', paymentNetwork, txHash, detectedAmount: incoming,
      reason: 'txHash already attributed', detail: `existing order ${alreadyUsed.orderRef} status=${alreadyUsed.status}`,
    })
    return { matched: true, orderId: alreadyUsed.id, orderRef: alreadyUsed.orderRef, reason: 'duplicate' }
  }

  const lo = (incoming * 0.99).toFixed(4)
  const hi = (incoming * 1.01).toFixed(4)

  // ── Pass 1: payment_uploaded order where the user submitted this exact tx hash ──
  const txHashUploadedOrder = await db.gasFeeOrder.findFirst({
    where: { status: 'payment_uploaded', paymentNetwork, paymentTxHash: txHash },
  })
  if (txHashUploadedOrder) {
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: txHashUploadedOrder.id, status: 'payment_uploaded' },
      data: {
        status: 'payment_detected',
        paymentVerifiedAt: new Date(),
        verifiedAmount: incoming,
        verifiedAsset: 'USDT',
        verifiedConfirmations: confirmations,
      },
    })
    if (claimed.count > 0) {
      await recordGasAudit({ orderId: txHashUploadedOrder.id, txHash }, {
        source, event: 'matched', matchPass: 'tx_hash', paymentNetwork, txHash,
        detectedAmount: incoming, detectedAsset: 'USDT', confirmations,
        ...(senderAddress ? { fromAddress: senderAddress } : {}),
        toAddress: depositAddress, expectedAmount: Number(txHashUploadedOrder.paymentAmount), expectedChain: txHashUploadedOrder.chain,
      })
      await onPaymentDetected(txHashUploadedOrder.id, txHashUploadedOrder.orderRef, txHashUploadedOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress, source)
    }
    return { matched: true, orderId: txHashUploadedOrder.id, orderRef: txHashUploadedOrder.orderRef }
  }

  // ── Pass A: exact unique-amount match ─────────────────────────────────────────
  const exLo = (incoming - EXACT_MATCH_EPSILON).toFixed(4)
  const exHi = (incoming + EXACT_MATCH_EPSILON).toFixed(4)
  const exactCandidates = await db.gasFeeOrder.findMany({
    where: {
      status: { in: ['payment_pending', 'payment_uploaded'] },
      paymentNetwork,
      paymentAmount: { gte: exLo, lte: exHi },
      paymentTxHash: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: 2,
  })
  if (exactCandidates.length === 1) {
    const ord = exactCandidates[0]!
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: ord.id, status: { in: ['payment_pending', 'payment_uploaded'] }, paymentTxHash: null },
      data: {
        status: 'payment_detected',
        paymentTxHash: txHash,
        paymentVerifiedAt: new Date(),
        verifiedAmount: incoming,
        verifiedAsset: 'USDT',
        verifiedConfirmations: confirmations,
      },
    })
    if (claimed.count > 0) {
      await recordGasAudit({ orderId: ord.id, txHash }, {
        source, event: 'matched', matchPass: 'exact', paymentNetwork, txHash,
        detectedAmount: incoming, detectedAsset: 'USDT', confirmations,
        ...(senderAddress ? { fromAddress: senderAddress } : {}),
        toAddress: depositAddress, expectedAmount: Number(ord.paymentAmount), expectedChain: ord.chain,
      })
      await onPaymentDetected(ord.id, ord.orderRef, ord.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress, source)
    }
    return { matched: true, orderId: ord.id, orderRef: ord.orderRef }
  }
  if (exactCandidates.length > 1) {
    await parkUnattributed(txHash, incoming, paymentNetwork, depositAddress, 'ambiguous_exact_collision')
    await recordGasAudit({ txHash }, { source, event: 'parked', paymentNetwork, txHash, detectedAmount: incoming, reason: 'ambiguous_exact_collision' })
    logger.warn({ txHash, incoming, paymentNetwork }, 'gas.matching: exact amount matched multiple orders — parked')
    return { matched: false, reason: 'ambiguous_exact_collision' }
  }

  // ── Pass 2: tolerant amount-based match ───────────────────────────────────────
  const candidates = await db.gasFeeOrder.findMany({
    where: {
      status: { in: ['payment_pending', 'payment_uploaded'] },
      paymentNetwork,
      paymentAmount: { gte: lo, lte: hi },
      paymentTxHash: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'asc' },
    take: 2,
  })

  if (candidates.length > 1) {
    await parkUnattributed(txHash, incoming, paymentNetwork, depositAddress, 'ambiguous_multiple_matches')
    await recordGasAudit({ txHash }, { source, event: 'parked', paymentNetwork, txHash, detectedAmount: incoming, reason: 'ambiguous_multiple_matches', detail: `${candidates.length} candidates` })
    logger.warn({ txHash, incoming, paymentNetwork, candidateCount: candidates.length }, 'gas.matching: ambiguous amount match — parked, NOT auto-delivering')
    sendAdminAlertEmail(
      'Ambiguous Gas Fee Payment — manual review',
      `A USDT payment (${incoming}) on ${paymentNetwork} matched ${candidates.length} pending gas orders by amount.\n\nTX: ${txHash}\n\nAuto-delivery was skipped to avoid crediting the wrong user. Attribute manually at /admin/gas.`,
    ).catch(() => {})
    return { matched: false, reason: 'ambiguous_multiple_matches' }
  }

  const activeOrder = candidates[0]
  if (activeOrder) {
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: activeOrder.id, status: { in: ['payment_pending', 'payment_uploaded'] }, paymentTxHash: null },
      data: {
        status: 'payment_detected',
        paymentTxHash: txHash,
        paymentVerifiedAt: new Date(),
        verifiedAmount: incoming,
        verifiedAsset: 'USDT',
        verifiedConfirmations: confirmations,
      },
    })
    if (claimed.count > 0) {
      await recordGasAudit({ orderId: activeOrder.id, txHash }, {
        source, event: 'matched', matchPass: 'tolerant', paymentNetwork, txHash,
        detectedAmount: incoming, detectedAsset: 'USDT', confirmations,
        ...(senderAddress ? { fromAddress: senderAddress } : {}),
        toAddress: depositAddress, expectedAmount: Number(activeOrder.paymentAmount), expectedChain: activeOrder.chain,
      })
      await onPaymentDetected(activeOrder.id, activeOrder.orderRef, activeOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress, source)
    }
    return { matched: true, orderId: activeOrder.id, orderRef: activeOrder.orderRef }
  }

  // ── Pass 3: grace match — recently-expired order where payment arrived on time ──
  const expiredOrder = await db.gasFeeOrder.findFirst({
    where: {
      status: 'expired',
      paymentNetwork,
      paymentAmount: { gte: lo, lte: hi },
      expiresAt: { gte: graceCutoff },
      paymentTxHash: null,
    },
    orderBy: { createdAt: 'asc' },
  })

  if (expiredOrder) {
    const blockTimestampMs = await p.getBlockTimestampMs()
    const paidBeforeExpiry =
      blockTimestampMs === null || blockTimestampMs < expiredOrder.expiresAt.getTime()

    if (paidBeforeExpiry) {
      const claimed = await db.gasFeeOrder.updateMany({
        where: { id: expiredOrder.id, status: 'expired', paymentTxHash: null },
        data: {
          status: 'payment_detected',
          paymentTxHash: txHash,
          paymentVerifiedAt: new Date(),
          verifiedAmount: incoming,
          verifiedAsset: 'USDT',
          verifiedConfirmations: confirmations,
        },
      })
      if (claimed.count > 0) {
        await recordGasAudit({ orderId: expiredOrder.id, txHash }, {
          source, event: 'matched', matchPass: 'grace', paymentNetwork, txHash,
          detectedAmount: incoming, detectedAsset: 'USDT', confirmations,
          ...(senderAddress ? { fromAddress: senderAddress } : {}),
          toAddress: depositAddress, expectedAmount: Number(expiredOrder.paymentAmount), expectedChain: expiredOrder.chain,
          detail: 'resurrected expired order — payment was on time',
        })
        await onPaymentDetected(expiredOrder.id, expiredOrder.orderRef, expiredOrder.chain, txHash, incoming, confirmations, paymentNetwork, senderAddress, source)
        sendAdminAlertEmail(
          `Gas Order Resurrected — Late Payment Detection`,
          `Order ref: ${expiredOrder.orderRef}\nOrder ID: ${expiredOrder.id}\nNetwork: ${paymentNetwork}\nAmount: ${incoming} USDT\nTx Hash: ${txHash}\n\nPayment was on-chain before expiry but the webhook never fired. ${source} detected, attributed, and queued delivery automatically.`,
        ).catch(() => {})
      }
      return { matched: true, orderId: expiredOrder.id, orderRef: expiredOrder.orderRef }
    }
  }

  // ── No match — record as unattributed for admin review ────────────────────────
  await parkUnattributed(txHash, incoming, paymentNetwork, depositAddress, 'no_match')
  await recordGasAudit({ txHash }, { source, event: 'unattributed', paymentNetwork, txHash, detectedAmount: incoming, confirmations, reason: 'no_matching_order' })
  logger.warn({ txHash, incoming, paymentNetwork }, 'gas.matching: unattributed transfer — no matching order')
  void createAdminNotif({
    category: 'GAS',
    title: `Unattributed Deposit — ${incoming.toFixed(2)} USDT (${paymentNetwork})`,
    body: `Received ${incoming.toFixed(4)} USDT but no matching order found. Needs manual attribution. Tx: ${txHash.slice(0, 12)}…`,
    href: '/admin/gas/flagged',
    metadata: { txHash, amount: incoming.toFixed(4), network: paymentNetwork },
  })
  return { matched: false, reason: 'no_match' }
}

export async function parkUnattributed(txHash: string, incoming: number, paymentNetwork: string, depositAddress: string, paymentNote: string): Promise<void> {
  const member = JSON.stringify({
    txHash,
    amount: incoming.toFixed(4),
    network: paymentNetwork,
    toAddress: depositAddress,
    paymentNote,
    detectedAt: new Date().toISOString(),
  })
  await redis.zadd('gas_unattributed', Date.now(), member)
  await redis.zremrangebyrank('gas_unattributed', 0, -101) // keep newest 100
}

// Queue automatic delivery (same path as the webhook), then record ledger + notif.
async function onPaymentDetected(
  orderId: string,
  orderRef: string,
  orderChain: string,
  txHash: string,
  incoming: number,
  confirmations: number,
  paymentNetwork: string,
  senderAddress: string | undefined,
  source: 'poller' | 'webhook',
): Promise<void> {
  // Queue delivery FIRST and await it — this is the money path, not fire-and-forget.
  // The worker claims payment_detected → sending via CAS, so a duplicate enqueue is safe.
  try {
    await queues.gasFee.add('deliver', { orderId }, { priority: 1 })
    await recordGasAudit({ orderId, txHash }, { source, event: 'delivery_queued', paymentNetwork, txHash, detail: 'gasFee deliver job enqueued' })
  } catch (err) {
    await recordGasAudit({ orderId, txHash }, { source, event: 'delivery_queue_failed', paymentNetwork, txHash, reason: (err as Error)?.message ?? 'enqueue failed' })
    logger.error({ err, orderId }, 'gas.matching: failed to queue delivery — will retry next tick (order stays payment_detected)')
  }

  try {
    // Record the payment on the chain it actually settled on (BNB/TRON/Ethereum/
    // Aptos), derived from paymentNetwork — NOT the gas-delivery chain (orderChain).
    // The delivery chain is kept only as the required `chain` fallback.
    const settle = paymentNetworkSettlementChain(paymentNetwork)
    appendLedgerEntry({
      entryType:      'order_payment',
      chain:          fromDbChain(orderChain) as GasChainId,
      ...(settle ? { chainOverride: settle } : {}),
      nativeAmount:   0,          // USDT is a token — no native moved
      usdAmount:      incoming,   // USDT ≈ USD 1:1
      tokenSymbol:    'USDT',
      tokenAmount:    incoming,
      txHash,
      ...(senderAddress !== undefined ? { fromAddress: senderAddress } : {}),
      relatedOrderId: orderId,
    }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write order_payment ledger entry'))

    void createAdminNotif({
      category: 'GAS',
      title: `Payment Detected — ${incoming.toFixed(2)} USDT (${paymentNetwork})`,
      body: `Order ${orderRef} payment confirmed on-chain (${confirmations} conf). Delivery queued automatically. Tx: ${txHash.slice(0, 12)}…`,
      href: `/admin/gas/orders/${orderRef}`,
      metadata: { txHash, amount: incoming.toFixed(4), network: paymentNetwork, orderId, confirmations },
    })

    logger.info({ txHash, orderId, network: paymentNetwork, incoming, confirmations, source }, 'gas.matching: payment detected — delivery queued')
  } catch (err) {
    logger.warn({ err, orderId, txHash }, 'gas.matching: onPaymentDetected post-processing failed')
  }
}
