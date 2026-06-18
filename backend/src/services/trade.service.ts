import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { assertCloudinaryUrl } from '../lib/upload'
type Tx = Prisma.TransactionClient
import { sendTradeEmail } from './email.service'
import { queues } from '../queues/definitions'
import { generateOrderRef } from '../lib/hash'
import { notify } from '../lib/notify'
import { createAdminNotif } from './adminNotification.service'
import { FLAGS, isFlagEnabled } from './platformFlags.service'
import {
  verifyTradeTx,
  assertNoDuplicateTradeTxHash,
  HARD_REJECT_STATUSES,
  ADMIN_REVIEW_STATUSES,
  RELEASE_ALLOWED_STATUSES,
} from './blockchainVerification.service'
import { logger } from '../lib/logger'

// ─── Payment-method resolution ──────────────────────────────────────────────
// A trade stores `paymentMethod` as the buyer's selection. For current trades
// that is a PaymentMethod *id* (the buyer picks one of the seller's receiving
// accounts attached to the ad); legacy trades may hold a plain label. We resolve
// it to (a) a clean display label and (b) the seller's account details, so the
// buyer can see exactly where to send PKR instead of asking in chat.

const PM_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay',
  nayapay: 'NayaPay', bank_transfer: 'Bank Transfer',
}

// Detects opaque CUIDs (PaymentMethod ids) so a raw id is never shown as a label.
function isOpaquePaymentId(value: string): boolean {
  const v = value.trim()
  if (v.includes(' ')) return false
  return /^[a-z][a-z0-9]{19,}$/.test(v)
}

interface PmFields {
  type: string
  accountName: string
  mobileNumber: string | null
  bankName: string | null
  ibanNumber: string | null
  accountNumber: string | null
}

// Builds the immutable account object stored on the trade / returned to the room.
export function buildPaymentAccountSnapshot(pm: PmFields) {
  const label = pm.type === 'bank_transfer'
    ? (pm.bankName ?? 'Bank Transfer')
    : (PM_LABELS[pm.type] ?? pm.type)
  return {
    type: pm.type,
    label,
    accountName: pm.accountName,
    ...(pm.mobileNumber ? { mobileNumber: pm.mobileNumber } : {}),
    ...(pm.bankName ? { bankName: pm.bankName } : {}),
    ...(pm.ibanNumber ? { ibanNumber: pm.ibanNumber } : {}),
    ...(pm.accountNumber ? { accountNumber: pm.accountNumber } : {}),
  }
}

// Read-time fallback for legacy trades created before sellerPaymentSnapshot
// existed (or where the value is a plain label, not a PaymentMethod id).
async function resolveSellerPaymentAccount(paymentMethod: string, sellerId: string) {
  const looksLikeId = isOpaquePaymentId(paymentMethod)
  // Only query when the value looks like an id; a plain label can't be an id.
  // Scope to the seller so a buyer can never resolve an unrelated account.
  const pm = looksLikeId
    ? await db.paymentMethod.findFirst({ where: { id: paymentMethod, userId: sellerId } })
    : null

  if (pm) {
    const account = buildPaymentAccountSnapshot(pm)
    return { label: account.label, account }
  }

  // Unresolvable (legacy label, or the account was deleted): show the label as-is,
  // but never leak a raw CUID. No account block renders in that case.
  return { label: looksLikeId ? 'Seller payment account' : paymentMethod, account: null }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTradeInput {
  amount: number
  paymentMethod: string
  buyerWalletAddress: string
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
}

export interface GetTradesParams {
  status?: string
  page?: number
  limit?: number
  role?: 'buyer' | 'seller'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function recalcSellerResponseTime(tx: Prisma.TransactionClient, sellerId: string) {
  const recentTrades = await tx.trade.findMany({
    where: {
      sellerId,
      status: 'crypto_released',
      paymentUploadedAt: { not: null },
      paymentConfirmedAt: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { paymentUploadedAt: true, paymentConfirmedAt: true },
  })

  const times = recentTrades
    .map((t) => {
      if (!t.paymentUploadedAt || !t.paymentConfirmedAt) return null
      const mins = Math.round((t.paymentConfirmedAt.getTime() - t.paymentUploadedAt.getTime()) / 60_000)
      return mins > 0 ? mins : null
    })
    .filter((v): v is number => v !== null)

  if (times.length === 0) return

  times.sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  const median = times.length % 2 !== 0
    ? times[mid]!
    : Math.round((times[mid - 1]! + times[mid]!) / 2)

  await tx.tradeStats.upsert({
    where: { userId: sellerId },
    create: { userId: sellerId, avgResponseMinutes: median },
    update: { avgResponseMinutes: median },
  })
}

async function recalcSellerReleaseTime(tx: Prisma.TransactionClient, sellerId: string) {
  const recentTrades = await tx.trade.findMany({
    where: {
      sellerId,
      status: 'crypto_released',
      paymentConfirmedAt: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { paymentConfirmedAt: true, updatedAt: true },
  })

  const times = recentTrades
    .map((t) => {
      if (!t.paymentConfirmedAt) return null
      const mins = Math.round((t.updatedAt.getTime() - t.paymentConfirmedAt.getTime()) / 60_000)
      return mins > 0 ? mins : null
    })
    .filter((v): v is number => v !== null)

  if (times.length === 0) return

  times.sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  const median = times.length % 2 !== 0
    ? times[mid]!
    : Math.round((times[mid - 1]! + times[mid]!) / 2)

  await tx.tradeStats.upsert({
    where: { userId: sellerId },
    create: { userId: sellerId, avgReleaseMinutes: median },
    update: { avgReleaseMinutes: median },
  })
}

async function upsertTradeStats(
  tx: Prisma.TransactionClient,
  userId: string,
  isCompleted: boolean,
  fiatAmount: Prisma.Decimal,
) {
  const stats = await tx.tradeStats.findUnique({ where: { userId } })
  if (!stats) {
    const completedTrades = isCompleted ? 1 : 0
    await tx.tradeStats.create({
      data: {
        userId,
        totalTrades: 1,
        completedTrades,
        cancelledTrades: 0,
        completionRate: new Prisma.Decimal(isCompleted ? 1 : 0),
        totalVolumePKR: isCompleted ? fiatAmount : new Prisma.Decimal(0),
      },
    })
  } else {
    const newTotal = stats.totalTrades + 1
    const newCompleted = stats.completedTrades + (isCompleted ? 1 : 0)
    const completionRate = new Prisma.Decimal(newCompleted).div(new Prisma.Decimal(newTotal))
    await tx.tradeStats.update({
      where: { userId },
      data: {
        totalTrades: newTotal,
        completedTrades: newCompleted,
        completionRate,
        ...(isCompleted ? { totalVolumePKR: { increment: fiatAmount } } : {}),
      },
    })
  }
}

// ─── Service Functions ────────────────────────────────────────────────────────

export async function createTrade(buyerId: string, adId: string, data: CreateTradeInput) {
  // Idempotency: claim the key with SET NX BEFORE the transaction so two
  // concurrent submissions (double-click / retry) can't both create a trade.
  const idempKey = `idempotency:trade:${buyerId}:${adId}:${data.amount}:${data.paymentMethod}`
  const existing = await redis.get(idempKey)
  if (existing && existing !== 'pending') {
    const prior = await db.trade.findUnique({ where: { id: existing } })
    if (prior) return prior
  }
  const claimed = await redis.set(idempKey, 'pending', 'EX', 300, 'NX')
  if (claimed !== 'OK') {
    // Another request is creating this exact trade right now (or just did).
    throw new AppError('DUPLICATE_REQUEST', 'A matching trade is already being created. Please wait a moment.', 409)
  }

  let trade: Awaited<ReturnType<typeof db.trade.create>>
  try {
    trade = await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE on buyer user
    const [buyerRows] = await tx.$queryRaw<Array<{
      id: string; dailyBuyUsed: Prisma.Decimal; dailyBuyLimit: Prisma.Decimal;
      dailyBuyReset: Date | null; isBanned: boolean; isSuspended: boolean; kycStatus: string
    }>>`
      SELECT id, "dailyBuyUsed", "dailyBuyLimit", "dailyBuyReset", "isBanned", "isSuspended", "kycStatus"
      FROM "User"
      WHERE id = ${buyerId}
      FOR UPDATE
    `
    if (!buyerRows) throw new AppError('NOT_FOUND', 'Buyer not found', 404)
    if (buyerRows.isBanned) throw new AppError('ACCOUNT_BANNED', 'Account is banned', 403)
    if (buyerRows.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended', 403)
    if (buyerRows.kycStatus !== 'approved') throw new AppError('KYC_REQUIRED', 'KYC verification required to trade', 403)

    // SELECT FOR UPDATE on ad
    const [adRows] = await tx.$queryRaw<Array<{
      id: string
      userId: string
      side: string
      coin: string
      network: string
      price: Prisma.Decimal
      availableAmount: Prisma.Decimal
      minOrder: Prisma.Decimal
      maxOrder: Prisma.Decimal
      status: string
      tradeWindow: number
      paymentMethods: string[]
    }>>`
      SELECT id, "userId", side, coin, network, price, "availableAmount", "minOrder", "maxOrder", status, "tradeWindow", "paymentMethods"
      FROM "Ad"
      WHERE id = ${adId}
      FOR UPDATE
    `
    if (!adRows) throw new AppError('NOT_FOUND', 'Ad not found', 404)

    if (adRows.status !== 'active') throw new AppError('AD_INACTIVE', 'This ad is not active', 400)
    if (adRows.coin !== 'USDT') throw new AppError('UNSUPPORTED_ASSET', 'Only USDT ads are supported on this marketplace', 400)
    if (!['BEP20', 'Aptos'].includes(adRows.network)) throw new AppError('UNSUPPORTED_NETWORK', 'Only BEP20 and Aptos networks are supported', 400)
    if (adRows.side !== 'sell') throw new AppError('INVALID_AD', 'Can only trade on sell ads', 400)
    if (adRows.userId === buyerId) throw new AppError('SELF_TRADE', 'Cannot trade on your own ad', 400)

    const amount = new Prisma.Decimal(data.amount)
    if (amount.lt(adRows.minOrder)) {
      throw new AppError('AMOUNT_TOO_LOW', `Minimum order is ${adRows.minOrder}`, 400)
    }
    if (amount.gt(adRows.maxOrder)) {
      throw new AppError('AMOUNT_TOO_HIGH', `Maximum order is ${adRows.maxOrder}`, 400)
    }
    if (amount.gt(adRows.availableAmount)) {
      throw new AppError('INSUFFICIENT_AMOUNT', 'Requested amount exceeds available amount', 400)
    }

    // Check daily buy limit — reset used amount if the daily window has rolled over
    const now = new Date()
    const needsReset = buyerRows.dailyBuyReset && now > buyerRows.dailyBuyReset
    const effectiveDailyUsed = needsReset ? new Prisma.Decimal(0) : new Prisma.Decimal(buyerRows.dailyBuyUsed)
    const dailyBuyLimit = new Prisma.Decimal(buyerRows.dailyBuyLimit)
    const fiatAmount = amount.mul(adRows.price)
    if (effectiveDailyUsed.add(fiatAmount).gt(dailyBuyLimit)) {
      throw new AppError('DAILY_LIMIT_EXCEEDED', 'Daily buy limit would be exceeded', 400)
    }

    // Decrement availableAmount
    const newAvailable = adRows.availableAmount.sub(amount)
    const newAdStatus = newAvailable.lte(0) ? 'completed' : 'active'

    await tx.ad.update({
      where: { id: adId },
      data: { availableAmount: newAvailable, status: newAdStatus },
    })

    // Increment buyer dailyBuyUsed (reset counter first if window rolled over)
    const resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    await tx.user.update({
      where: { id: buyerId },
      data: {
        dailyBuyUsed: needsReset ? fiatAmount : { increment: fiatAmount },
        ...(needsReset ? { dailyBuyReset: resetAt } : {}),
      },
    })

    // Snapshot the seller's receiving account now, so the buyer's pay-to details
    // are locked for the life of the trade (immutable dispute evidence) even if
    // the seller later edits or deletes that payment method. data.paymentMethod is
    // a PaymentMethod id for current trades; scope the lookup to the ad owner.
    let sellerPaymentSnapshot: Prisma.InputJsonValue | undefined
    if (isOpaquePaymentId(data.paymentMethod)) {
      const pm = await tx.paymentMethod.findFirst({
        where: { id: data.paymentMethod, userId: adRows.userId },
        select: { type: true, accountName: true, mobileNumber: true, bankName: true, ibanNumber: true, accountNumber: true },
      })
      if (pm) sellerPaymentSnapshot = buildPaymentAccountSnapshot(pm)
    }

    // Create the trade
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000)
    const orderRef = generateOrderRef('TRD')

    const newTrade = await tx.trade.create({
      data: {
        orderRef,
        adId,
        buyerId,
        sellerId: adRows.userId,
        coin: adRows.coin,
        network: adRows.network,
        amount,
        price: adRows.price,
        fiatAmount,
        paymentMethod: data.paymentMethod,
        ...(sellerPaymentSnapshot ? { sellerPaymentSnapshot } : {}),
        buyerWalletAddress: data.buyerWalletAddress,
        ...(data.buyerDeliveryMethod ? { buyerDeliveryMethod: data.buyerDeliveryMethod } : {}),
        ...(data.buyerDeliveryAddress ? { buyerDeliveryAddress: data.buyerDeliveryAddress } : {}),
        status: 'payment_pending',
        expiresAt,
      },
    })

    // System message
    await tx.tradeMessage.create({
      data: {
        tradeId: newTrade.id,
        senderId: buyerId,
        message: 'Trade created. Please upload payment proof within the trade window.',
      },
    })

      return newTrade
    })
  } catch (err) {
    // Release the claim so a legitimate retry isn't blocked for 5 minutes.
    await redis.del(idempKey).catch(() => {})
    throw err
  }

  // Replace the 'pending' marker with the real trade id (5 min TTL) so a
  // sequential retry returns the same trade instead of creating a new one.
  await redis.set(idempKey, trade.id, 'EX', 300)

  return trade
}

export async function uploadPaymentProof(tradeId: string, buyerId: string, proofUrl: string) {
  assertCloudinaryUrl(proofUrl, 'proofUrl')

  // Load seller info for email — safe outside tx (read-only, non-critical timing)
  const tradeForEmail = await db.trade.findUnique({
    where: { id: tradeId },
    select: { seller: { select: { email: true, username: true } }, sellerId: true, orderRef: true, coin: true, amount: true, fiatAmount: true },
  })
  if (!tradeForEmail) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // Use optimistic updateMany with status guard — prevents two concurrent uploads both succeeding
  const result = await db.trade.updateMany({
    where: { id: tradeId, buyerId, status: 'payment_pending' },
    data: { status: 'payment_uploaded', paymentProofUrl: proofUrl, paymentUploadedAt: new Date() },
  })

  if (result.count === 0) {
    // Distinguish "not your trade" from "wrong status" with a secondary read
    const check = await db.trade.findUnique({ where: { id: tradeId }, select: { buyerId: true, status: true } })
    if (!check) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (check.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Not your trade', 403)
    throw new AppError('INVALID_STATUS', `Cannot upload proof for trade in status: ${check.status}`, 400)
  }

  const updated = await db.trade.findUniqueOrThrow({ where: { id: tradeId } })

  notify(tradeForEmail.sellerId, 'trade', 'Payment Proof Uploaded', 'The buyer has uploaded payment proof. Please review and confirm.', { tradeId }, tradeId)
  createAdminNotif({ category: 'TRADE', title: 'Payment Proof Uploaded', body: `Trade #${tradeForEmail.orderRef} — buyer uploaded payment proof.`, href: `/admin/trades/${tradeId}` })

  // Notify seller via email
  await sendTradeEmail(
    'payment_uploaded',
    {
      orderRef: tradeForEmail.orderRef,
      coin: tradeForEmail.coin,
      amount: tradeForEmail.amount.toString(),
      pkrValue: tradeForEmail.fiatAmount.toString(),
      counterpartyUsername: 'Buyer',
    },
    tradeForEmail.seller.email,
  )

  return updated
}

export async function confirmPayment(
  tradeId: string,
  actorId: string,
  role: string,
  opts?: { confirmedReceipt?: boolean },
) {
  // Verified-receipt rule (non-custodial): the seller must confirm the money has
  // actually landed in their account — never release on a screenshot alone. The
  // client must send an explicit acknowledgment. Admins are exempt. Flag OFF
  // preserves the original one-click confirm behavior.
  const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
  if (role !== 'admin' && opts?.confirmedReceipt !== true && nonCustodial) {
    throw new AppError(
      'RECEIPT_NOT_CONFIRMED',
      'Confirm that the payment has actually arrived in your account (a screenshot is not enough) before releasing.',
      400,
    )
  }

  // Release window: once payment is confirmed, the seller must release within
  // RELEASE_WINDOW_MIN or the trade auto-escalates to a dispute (see
  // tradeEscalation.job). Only enforced in non-custodial mode.
  const RELEASE_WINDOW_MIN = 15
  const releaseDeadlineAt = nonCustodial
    ? new Date(Date.now() + RELEASE_WINDOW_MIN * 60 * 1000)
    : null

  const updated = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; sellerId: string; buyerId: string }>>`
      SELECT id, status, "sellerId", "buyerId" FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `
    const trade = rows[0]
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

    if (role !== 'admin' && trade.sellerId !== actorId) {
      throw new AppError('FORBIDDEN', 'Only the seller or admin can confirm payment', 403)
    }
    if (trade.status !== 'payment_uploaded') {
      throw new AppError('INVALID_STATUS', `Cannot confirm payment for trade in status: ${trade.status}`, 400)
    }

    return tx.trade.update({
      where: { id: tradeId },
      data: {
        status: 'payment_confirmed',
        paymentConfirmedAt: new Date(),
        ...(releaseDeadlineAt ? { releaseDeadlineAt } : {}),
      },
    })
  })

  notify(updated.buyerId, 'trade', 'Payment Confirmed', 'The seller has confirmed your payment. Crypto will be sent soon.', { tradeId }, tradeId)
  return updated
}

export async function markCryptoSent(tradeId: string, sellerId: string, txHash: string) {
  const txHashNorm = txHash.trim().toLowerCase()

  // Load trade outside the transaction so we can run async blockchain RPC calls
  // before acquiring the DB lock — RPC calls can take several seconds.
  const tradeForVerify = await db.trade.findUnique({
    where: { id: tradeId },
    select: { id: true, status: true, sellerId: true, coin: true, network: true, amount: true, buyerWalletAddress: true, buyerDeliveryAddress: true, buyerDeliveryMethod: true },
  })
  if (!tradeForVerify) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (tradeForVerify.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only the seller can mark crypto as sent', 403)
  if (tradeForVerify.status !== 'payment_confirmed') {
    throw new AppError('INVALID_STATUS', `Cannot mark crypto sent for trade in status: ${tradeForVerify.status}`, 400)
  }

  // ── Duplicate hash guard ──────────────────────────────────────────────────────
  // The same on-chain tx can only prove one trade. Block replay before RPC calls.
  await assertNoDuplicateTradeTxHash(txHashNorm, tradeId)

  // ── On-chain verification ─────────────────────────────────────────────────────
  // Resolve the buyer's destination address: blockchain delivery takes priority
  // over the generic buyerWalletAddress field (which may hold a legacy value).
  const buyerWallet =
    (tradeForVerify.buyerDeliveryMethod === 'blockchain' && tradeForVerify.buyerDeliveryAddress)
      ? tradeForVerify.buyerDeliveryAddress
      : tradeForVerify.buyerWalletAddress

  let verificationResult
  try {
    verificationResult = await verifyTradeTx(
      txHashNorm,
      tradeForVerify.coin,
      tradeForVerify.network,
      tradeForVerify.amount,
      buyerWallet,
    )
  } catch (err) {
    // Unexpected errors from the verifier must not silently swallow — if it's
    // an AppError we already threw a user-visible error; rethrow anything else.
    throw err
  }

  logger.info(
    { tradeId, txHash: txHashNorm, verificationStatus: verificationResult.status, chain: tradeForVerify.network },
    'markCryptoSent: blockchain verification result',
  )

  // ── Rejection gate ────────────────────────────────────────────────────────────
  // Hard-reject any status that is definitively wrong or unconfirmed.
  // A fake/wrong/unconfirmed hash must NEVER move the trade forward.
  if (HARD_REJECT_STATUSES.includes(verificationResult.status)) {
    const userMessages: Record<string, string> = {
      reverted: 'The transaction was reverted on-chain — no tokens were transferred. Check the explorer and resubmit a successful transaction.',
      mismatch_receiver: `The transaction does not send tokens to the buyer's wallet. ${verificationResult.message}`,
      mismatch_amount: `The transferred amount is less than the trade amount. ${verificationResult.message}`,
      failed: `Transaction verification failed. ${verificationResult.message}`,
      not_found: 'Transaction not found on this blockchain. Please ensure you submitted the correct hash and the transaction is confirmed, then resubmit.',
      pending: 'Transaction is not yet confirmed on-chain. Please wait for at least one block confirmation and resubmit.',
    }
    throw new AppError(
      'TX_VERIFICATION_FAILED',
      userMessages[verificationResult.status] ?? verificationResult.message,
      400,
    )
  }

  // Admin-review path: tx hash is stored, trade moves to crypto_sent, but buyer
  // is BLOCKED from releasing until an admin calls approve-tx-verification.
  // Applies to: skipped (non-EVM chain) and rpc_error (our node was down).
  const requiresAdminReview = ADMIN_REVIEW_STATUSES.includes(verificationResult.status)
  if (requiresAdminReview) {
    logger.warn(
      { tradeId, txHash: txHashNorm, status: verificationResult.status },
      'markCryptoSent: tx requires admin review before buyer can release',
    )
  }

  // ── Commit to DB ──────────────────────────────────────────────────────────────
  const updated = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; sellerId: string; buyerId: string }>>`
      SELECT id, status, "sellerId", "buyerId" FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `
    const trade = rows[0]
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only the seller can mark crypto as sent', 403)
    if (trade.status !== 'payment_confirmed') {
      throw new AppError('INVALID_STATUS', `Trade status changed concurrently: ${trade.status}`, 400)
    }

    return tx.trade.update({
      where: { id: tradeId },
      data: {
        status: 'crypto_sent',
        sellerTxHash: txHashNorm,
        txVerificationStatus: verificationResult.status,
        txVerificationDetails: verificationResult.details as Prisma.InputJsonValue,
      },
    })
  })

  const verifiedLabel = verificationResult.status === 'verified'
    ? ' (on-chain verified ✓)'
    : requiresAdminReview
      ? ' — awaiting admin verification before you can release'
      : ''
  notify(updated.buyerId, 'trade', 'Crypto Is on the Way', `The seller has sent the crypto${verifiedLabel}.`, { tradeId, txVerificationStatus: verificationResult.status }, tradeId)
  createAdminNotif({
    category: 'TRADE',
    title: `Tx Proof Submitted — ${verificationResult.status.toUpperCase()}${requiresAdminReview ? ' ⚠ NEEDS REVIEW' : ''}`,
    body: `Trade #${updated.orderRef} — seller tx hash. Verification: ${verificationResult.status}. ${verificationResult.message}${requiresAdminReview ? ' Admin must approve before buyer can release.' : ''}`,
    href: `/admin/trades/${tradeId}`,
  })
  return updated
}

export async function releaseTrade(tradeId: string, buyerId: string) {
  // Load buyer/seller details needed for emails/queues — safe to read outside tx
  const tradeDetails = await db.trade.findUnique({
    where: { id: tradeId },
    include: {
      buyer: { select: { email: true, username: true, firstTradeBonusPaid: true } },
      seller: { select: { email: true, username: true } },
    },
  })
  if (!tradeDetails) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // ── Verification gate ─────────────────────────────────────────────────────────
  // txVerificationStatus = null means a legacy trade created before the
  // verification system was deployed — allow it through for backward compat,
  // BUT only if a real on-chain seller tx hash exists. A null status with no
  // sellerTxHash is an inconsistent state that must never release funds.
  const vs = tradeDetails.txVerificationStatus
  if ((vs === null || vs === undefined) && !tradeDetails.sellerTxHash) {
    throw new AppError(
      'TX_NOT_VERIFIED',
      'Cannot release — this trade has no verified transaction on record. Please contact support.',
      400,
    )
  }
  if (vs !== null && vs !== undefined && !RELEASE_ALLOWED_STATUSES.includes(vs as never)) {
    const isAdminReview = ADMIN_REVIEW_STATUSES.includes(vs as never)
    throw new AppError(
      'TX_NOT_VERIFIED',
      isAdminReview
        ? 'This trade is pending admin verification of the transaction hash. Release will be available once an admin approves the transaction.'
        : `Cannot release — transaction verification status is "${vs}". Please contact support.`,
      400,
    )
  }

  await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE prevents concurrent release from double-completing
    const [rows] = await tx.$queryRaw<Array<{
      id: string; status: string; buyerId: string; sellerId: string; fiatAmount: Prisma.Decimal
    }>>`
      SELECT id, status, "buyerId", "sellerId", "fiatAmount"
      FROM "Trade"
      WHERE id = ${tradeId}
      FOR UPDATE
    `
    if (!rows) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (rows.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only the buyer can release the trade', 403)
    if (rows.status !== 'crypto_sent') {
      throw new AppError('INVALID_STATUS', `Cannot release trade in status: ${rows.status}`, 400)
    }

    await tx.trade.update({
      where: { id: tradeId },
      data: { status: 'crypto_released', escrowReleased: true },
    })

    // Increment completedSellTrades for seller
    await tx.user.update({
      where: { id: rows.sellerId },
      data: { completedSellTrades: { increment: 1 } },
    })

    // Update TradeStats for buyer and seller
    await upsertTradeStats(tx, buyerId, true, rows.fiatAmount)
    await upsertTradeStats(tx, rows.sellerId, true, rows.fiatAmount)

    // Recalculate seller's median response + release times from last 20 trades
    await recalcSellerResponseTime(tx, rows.sellerId)
    await recalcSellerReleaseTime(tx, rows.sellerId)
  })

  // Queue badge recalculation for both
  await queues.badgeRecalculate.add('recalculate', { userId: buyerId })
  await queues.badgeRecalculate.add('recalculate', { userId: tradeDetails.sellerId })

  // Queue referral payout if first trade bonus not yet paid
  if (!tradeDetails.buyer.firstTradeBonusPaid) {
    await queues.referralPayout.add('first-trade', { userId: buyerId, tradeId })
  }

  notify(tradeDetails.sellerId, 'trade', 'Trade Completed', 'The buyer has released the crypto. Trade is complete.', { tradeId }, tradeId)
  createAdminNotif({ category: 'TRADE', title: 'Trade Completed', body: `Trade #${tradeDetails.orderRef} has been completed.`, href: `/admin/trades/${tradeId}` })

  // Send completion emails
  await sendTradeEmail(
    'completed',
    {
      orderRef: tradeDetails.orderRef,
      coin: tradeDetails.coin,
      amount: tradeDetails.amount.toString(),
      pkrValue: tradeDetails.fiatAmount.toString(),
      counterpartyUsername: tradeDetails.seller.username,
    },
    tradeDetails.buyer.email,
  )

  return db.trade.findUnique({ where: { id: tradeId } })
}

export async function cancelTrade(tradeId: string, actorId: string, role: string, reason: string) {
  let buyerId: string
  let sellerId: string

  await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE prevents concurrent cancel+release from both succeeding
    const [trade] = await tx.$queryRaw<Array<{
      id: string; status: string; buyerId: string; sellerId: string;
      adId: string; amount: Prisma.Decimal; fiatAmount: Prisma.Decimal
    }>>`
      SELECT id, status, "buyerId", "sellerId", "adId", amount, "fiatAmount"
      FROM "Trade"
      WHERE id = ${tradeId}
      FOR UPDATE
    `
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

    if (role !== 'admin' && trade.buyerId !== actorId && trade.sellerId !== actorId) {
      throw new AppError('FORBIDDEN', 'Not authorized to cancel this trade', 403)
    }

    const cancellableStatuses = ['payment_pending', 'payment_uploaded']
    if (!cancellableStatuses.includes(trade.status)) {
      throw new AppError('INVALID_STATUS', `Cannot cancel trade in status: ${trade.status}`, 400)
    }

    // Once the buyer has uploaded payment proof they may have already sent fiat.
    // A seller cancelling here could keep the buyer's money — only the buyer
    // (who knows whether they actually paid) or an admin may cancel now.
    if (trade.status === 'payment_uploaded' && role !== 'admin' && trade.buyerId !== actorId) {
      throw new AppError(
        'FORBIDDEN',
        'Payment proof has been uploaded — only the buyer or an admin can cancel this trade. If the payment is invalid, open a dispute instead.',
        403,
      )
    }

    buyerId = trade.buyerId
    sellerId = trade.sellerId

    await tx.trade.update({
      where: { id: tradeId },
      data: {
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledBy: actorId,
      },
    })

    // Restore ad availableAmount
    const ad = await tx.ad.findUnique({ where: { id: trade.adId } })
    if (ad) {
      const restoredAmount = ad.availableAmount.add(trade.amount)
      const newStatus = ad.status === 'completed' ? 'active' : ad.status
      await tx.ad.update({
        where: { id: trade.adId },
        data: { availableAmount: restoredAmount, status: newStatus },
      })
    }

    // Restore buyer dailyBuyUsed — clamped at 0 because the daily window may
    // have rolled over (and been reset) since this trade incremented it.
    await tx.$executeRaw`
      UPDATE "User"
      SET "dailyBuyUsed" = GREATEST("dailyBuyUsed" - ${trade.fiatAmount}, 0)
      WHERE id = ${trade.buyerId}
    `
  })

  const otherPartyId = actorId === buyerId! ? sellerId! : buyerId!
  notify(otherPartyId, 'trade', 'Trade Cancelled', `A trade you were part of has been cancelled. Reason: ${reason}`, { tradeId }, tradeId)

  return db.trade.findUnique({ where: { id: tradeId } })
}

export async function openDispute(
  tradeId: string,
  openedById: string,
  reason: string,
  description: string,
) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  if (trade.buyerId !== openedById && trade.sellerId !== openedById) {
    throw new AppError('FORBIDDEN', 'Only buyer or seller can open a dispute', 403)
  }

  // crypto_sent is disputable: the seller's tx may be pending admin review
  // (non-EVM chains / RPC outage) or the buyer may claim non-receipt — without
  // this the buyer would be stuck unable to release, cancel, OR dispute.
  const disputeStatuses = ['payment_uploaded', 'payment_confirmed', 'crypto_sent']
  if (!disputeStatuses.includes(trade.status)) {
    throw new AppError('INVALID_STATUS', `Cannot open dispute for trade in status: ${trade.status}`, 400)
  }

  let dispute: Awaited<ReturnType<typeof db.dispute.create>>
  try {
    dispute = await db.$transaction(async (tx: Tx) => {
      const newDispute = await tx.dispute.create({
        data: { tradeId, openedById, reason, description },
      })

      await tx.trade.update({
        where: { id: tradeId },
        data: { status: 'disputed' },
      })

      return newDispute
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('CONFLICT', 'A dispute already exists for this trade', 409)
    }
    throw err
  }

  const otherPartyId = openedById === trade.buyerId ? trade.sellerId : trade.buyerId
  notify(otherPartyId, 'dispute', 'Dispute Opened', `A dispute has been opened on your trade. Reason: ${reason}`, { tradeId, disputeId: dispute.id }, tradeId)
  notify(openedById, 'dispute', 'Dispute Submitted', 'Your dispute has been submitted and will be reviewed by an admin.', { tradeId, disputeId: dispute.id }, tradeId)
  createAdminNotif({ category: 'DISPUTE', title: 'New Dispute Opened', body: `Dispute on Trade #${trade.orderRef}: ${reason}`, href: `/admin/disputes` })

  return dispute
}

export async function sendMessage(
  tradeId: string,
  senderId: string,
  content: string,
  attachmentUrl?: string,
) {
  const [trade, sender] = await Promise.all([
    db.trade.findUnique({ where: { id: tradeId } }),
    db.user.findUnique({ where: { id: senderId }, select: { username: true } }),
  ])
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // Sender must be buyer, seller — admin check done via role in route
  const isParticipant = trade.buyerId === senderId || trade.sellerId === senderId
  if (!isParticipant) throw new AppError('FORBIDDEN', 'Not a participant in this trade', 403)

  const msg = await db.tradeMessage.create({
    data: {
      tradeId,
      senderId,
      message: content,
      attachmentUrl: attachmentUrl ?? null,
    },
  })

  // Notify the other party. The in-app bell always updates live (SSE), but we
  // COALESCE the device buzz: the first message in a trade buzzes their phone,
  // then we go quiet for 5 minutes so a rapid back-and-forth negotiation can't
  // fire 20+ push/Telegram alerts. A fresh buzz resumes once the window lapses.
  const recipientId = trade.buyerId === senderId ? trade.sellerId : trade.buyerId
  const senderLabel = sender?.username ?? 'Someone'
  const preview = content.length > 60 ? content.slice(0, 57) + '…' : content

  // SET NX EX = atomically "claim" the buzz slot; succeeds only if no key exists.
  // null reply ⇒ a buzz already fired within the window ⇒ deliver silently.
  const buzzKey = `notif:chatbuzz:${recipientId}:${tradeId}`
  const claimed = await redis.set(buzzKey, '1', 'EX', 300, 'NX').catch(() => 'OK')
  const silent = claimed === null

  // Chat messages are NOT important enough for a Telegram DM (too frequent →
  // raises block/report rates). Web push + in-app bell only; telegram: false
  // force-excludes them even though they share type 'trade'.
  notify(recipientId, 'trade', 'New Message', `${senderLabel}: ${preview}`, { tradeId }, tradeId, undefined, { silent, telegram: false })

  return msg
}

export async function sendMessageAsAdmin(
  tradeId: string,
  senderId: string,
  content: string,
  attachmentUrl?: string,
) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  return db.tradeMessage.create({
    data: {
      tradeId,
      senderId,
      message: content,
      attachmentUrl: attachmentUrl ?? null,
    },
  })
}

export async function getMessages(tradeId: string, userId: string, role: string) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  const isAdmin = ['admin', 'super_admin', 'dispute_agent'].includes(role)
  const isParticipant = trade.buyerId === userId || trade.sellerId === userId

  if (!isAdmin && !isParticipant) {
    throw new AppError('FORBIDDEN', 'Not authorized to view messages', 403)
  }

  return db.tradeMessage.findMany({
    where: { tradeId },
    orderBy: { createdAt: 'asc' },
    include: {
      // We store senderId but can join for display info
    },
  })
}

export async function rateTrade(
  tradeId: string,
  raterId: string,
  rating: number,
  comment: string,
  tags: string[],
) {
  if (rating < 1 || rating > 5) throw new AppError('VALIDATION_ERROR', 'Rating must be between 1 and 5', 400)

  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.status !== 'crypto_released') {
    throw new AppError('INVALID_STATUS', 'Trade must be completed before rating', 400)
  }

  const isBuyer = trade.buyerId === raterId
  const isSeller = trade.sellerId === raterId
  if (!isBuyer && !isSeller) throw new AppError('FORBIDDEN', 'Only trade participants can rate', 403)

  // Check for duplicate rating
  const existing = await db.tradeRating.findUnique({
    where: { tradeId_ratedByUserId: { tradeId, ratedByUserId: raterId } },
  })
  if (existing) throw new AppError('CONFLICT', 'You have already rated this trade', 409)

  const rateeId = isBuyer ? trade.sellerId : trade.buyerId

  const tradeRating = await db.tradeRating.create({
    data: {
      tradeId,
      ratedByUserId: raterId,
      ratedUserId: rateeId,
      rating,
      comment,
      tags,
    },
  })

  // Update ratee's avgRating in TradeStats — aggregate in the DB rather than
  // pulling every rating row into memory (unbounded as a user accrues reviews).
  const agg = await db.tradeRating.aggregate({
    where: { ratedUserId: rateeId },
    _avg: { rating: true },
    _count: { _all: true },
  })
  const totalRatings = agg._count._all
  const avgRating = agg._avg.rating ?? 0

  await db.tradeStats.upsert({
    where: { userId: rateeId },
    create: {
      userId: rateeId,
      avgRating: new Prisma.Decimal(avgRating.toFixed(2)),
      totalReviews: totalRatings,
    },
    update: {
      avgRating: new Prisma.Decimal(avgRating.toFixed(2)),
      totalReviews: totalRatings,
    },
  })

  // Resolve usernames for admin notification
  const [rater, ratee] = await Promise.all([
    db.user.findUnique({ where: { id: raterId }, select: { username: true } }),
    db.user.findUnique({ where: { id: rateeId }, select: { username: true } }),
  ])
  createAdminNotif({
    category: 'TRADE',
    title: 'Rating Submitted',
    body: `${rater?.username ?? raterId} rated ${ratee?.username ?? rateeId} ${rating}★ on Trade #${trade.orderRef}${comment ? `: "${comment}"` : ''}`,
    href: `/admin/ratings`,
  })

  return tradeRating
}

export async function getTrades(userId: string, params: GetTradesParams) {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 50)
  const skip = (page - 1) * limit

  const statusFilter = params.status
    ? { status: params.status as 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed' }
    : {}

  let where: Prisma.TradeWhereInput

  if (params.role === 'buyer') {
    where = { buyerId: userId, ...statusFilter }
  } else if (params.role === 'seller') {
    where = { sellerId: userId, ...statusFilter }
  } else {
    where = { OR: [{ buyerId: userId }, { sellerId: userId }], ...statusFilter }
  }

  const [items, total] = await Promise.all([
    db.trade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        ad: { select: { id: true, side: true, coin: true, network: true } },
        buyer: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
        seller: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      },
    }),
    db.trade.count({ where }),
  ])

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTradeById(tradeId: string, userId: string, role: string) {
  const trade = await db.trade.findUnique({
    where: { id: tradeId },
    include: {
      ad: true,
      buyer: {
        select: {
          id: true, username: true, fullName: true, kycStatus: true, kycLevel: true, avatarUrl: true,
          tradeStats: { select: { badge: true, badgeLabel: true, trustScore: true, completedTrades: true, completionRate: true } },
        },
      },
      seller: {
        select: {
          id: true, username: true, fullName: true, kycStatus: true, kycLevel: true, avatarUrl: true,
          tradeStats: { select: { badge: true, badgeLabel: true, trustScore: true, completedTrades: true, completionRate: true } },
        },
      },
      messages: { orderBy: { createdAt: 'asc' } },
      dispute: true,
      ratings: true,
    },
  })

  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  const isAdmin = ['admin', 'super_admin', 'dispute_agent'].includes(role)
  const isParticipant = trade.buyerId === userId || trade.sellerId === userId

  if (!isAdmin && !isParticipant) {
    throw new AppError('FORBIDDEN', 'Not authorized to view this trade', 403)
  }

  // Check if the requesting user has already rated this trade
  const ratedByMeRecord = await db.tradeRating.findUnique({
    where: { tradeId_ratedByUserId: { tradeId, ratedByUserId: userId } },
    select: { id: true },
  })

  // Seller's receiving account so the buyer sees where to pay. Prefer the
  // immutable snapshot captured at creation; fall back to read-time resolution
  // for legacy trades created before the snapshot column existed. Only trade
  // participants reach this point (auth check above).
  const snap = trade.sellerPaymentSnapshot as { label?: string; accountName?: string } | null
  let paymentMethodLabel: string
  let sellerPaymentAccount: unknown
  if (snap && typeof snap === 'object' && typeof snap.accountName === 'string') {
    sellerPaymentAccount = snap
    paymentMethodLabel = snap.label ?? trade.paymentMethod
  } else {
    const resolvedPm = await resolveSellerPaymentAccount(trade.paymentMethod, trade.sellerId)
    paymentMethodLabel = resolvedPm.label
    sellerPaymentAccount = resolvedPm.account
  }

  return {
    ...trade,
    ratedByMe: !!ratedByMeRecord,
    paymentMethodLabel,
    sellerPaymentAccount,
  }
}
