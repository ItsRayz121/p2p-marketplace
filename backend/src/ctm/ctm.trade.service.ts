import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { assertTokenAddressFormat } from './ctm.address'
import { Prisma } from '@prisma/client'
import { decrementLockedAmount } from './ctm.listing.service'
import { queues } from '../queues/definitions'
import { verifyTradeTx, HARD_REJECT_STATUSES, ADMIN_REVIEW_STATUSES, RELEASE_ALLOWED_STATUSES } from '../services/blockchainVerification.service'
import { logger } from '../lib/logger'
import { generateCtmDisplayRef } from './ctm.ref'
import { notify as centralNotify } from '../lib/notify'
import { FLAGS, isFlagEnabled, getNumberConfig } from '../services/platformFlags.service'
import { getBondConfig, lockMakerBondTx, releaseMakerBond, resolveBondOnDispute } from '../services/makerBond.service'
import { recordAuditLog } from '../lib/audit'

type JsonValue = Prisma.InputJsonValue
type Tx = Prisma.TransactionClient

const ACTIVE_STATUSES = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] as const

// Delegate to the central notifier so CTM events fire SSE + web-push (not just a
// DB row). The push deep-links into the CTM trade room via metadata.tradeRef.
function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  const tradeRef = typeof metadata.tradeRef === 'string' ? metadata.tradeRef : undefined
  centralNotify(userId, type, title, body, metadata, undefined, tradeRef ? `/ctm/trade/${tradeRef}` : undefined)
}

/** Human-readable trade label for user-facing text — never exposes the raw cuid. */
function refLabel(displayRef: string | null | undefined): string {
  return displayRef ?? 'your CTM trade'
}

function isParticipant(trade: { buyerId: string; sellerId: string }, userId: string, role: string) {
  return trade.buyerId === userId || trade.sellerId === userId || role === 'admin' || role === 'super_admin'
}

export async function getMyTrades(userId: string, filters: { status?: string; role?: string; page?: number; limit?: number } = {}) {
  const { status, role, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit

  const roleFilter = role === 'buyer' ? { buyerId: userId } : role === 'seller' ? { sellerId: userId } : { OR: [{ buyerId: userId }, { sellerId: userId }] }
  const where: Record<string, unknown> = { ...roleFilter }
  if (status) where.status = status

  const [trades, total] = await Promise.all([
    db.ctmTrade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true } },
        buyer: { select: { id: true, username: true } },
        seller: { select: { id: true, username: true } },
        listing: { select: { id: true } },
      },
    }),
    db.ctmTrade.count({ where }),
  ])

  return { trades, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTradeByRef(tradeRef: string, userId: string, role: string) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: {
      token: true,
      buyer: { select: { id: true, username: true, fullName: true } },
      seller: { select: { id: true, username: true, fullName: true } },
      listing: true,
      request: true,
      proofs: { orderBy: { createdAt: 'asc' } },
      dispute: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
      ratings: true,
    },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!isParticipant(trade, userId, role)) throw new AppError('FORBIDDEN', 'Access denied', 403)
  const ratedByMeRecord = await db.ctmTradeRating.findFirst({ where: { tradeId: trade.id, ratedByUserId: userId } })

  // Admins also get the trade's audit trail (CTM audit logs key on tradeRef in metadata).
  let auditLogs: Array<{ id: string; action: string; actorId: string; createdAt: Date }> = []
  if (role === 'admin' || role === 'super_admin') {
    auditLogs = await db.auditLog.findMany({
      where: { action: { startsWith: 'CTM_' }, metadata: { path: ['tradeRef'], equals: tradeRef } },
      orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, action: true, actorId: true, createdAt: true },
    }).catch(() => [])
  }

  return { ...trade, ratedByMe: !!ratedByMeRecord, auditLogs }
}

export async function uploadPaymentProof(tradeRef: string, buyerId: string, fileUrl: string, fileHash: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only buyer can upload payment proof', 403)
  if (trade.status !== 'awaiting_payment') throw new AppError('CONFLICT', `Cannot upload proof in status: ${trade.status}`, 409)

  const duplicate = await db.ctmTradeProof.findFirst({ where: { tradeId: trade.id, fileHash } })
  if (duplicate) throw new AppError('CONFLICT', 'This file has already been uploaded', 409)

  const proofDeadlineAt = new Date(Date.now() + 60 * 60 * 1000) // seller has 1h to confirm

  await db.$transaction([
    db.ctmTrade.update({
      where: { id: trade.id },
      data: { status: 'payment_uploaded', paymentProofUrl: fileUrl, paymentProofHash: fileHash, proofDeadlineAt },
    }),
    db.ctmTradeProof.create({
      data: { tradeId: trade.id, uploadedBy: buyerId, proofType: 'screenshot', fileUrl, fileHash, description: 'Payment proof' },
    }),
  ])

  notify(trade.sellerId, 'CTM_PAYMENT_UPLOADED', 'Payment proof uploaded', 'Buyer has uploaded payment proof. Please confirm receipt.', { tradeRef })
}

export async function confirmPayment(tradeRef: string, sellerId: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can confirm payment', 403)
  if (trade.status !== 'payment_uploaded') throw new AppError('CONFLICT', `Cannot confirm payment in status: ${trade.status}`, 409)

  await db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'payment_confirmed', proofDeadlineAt: null } })
  notify(trade.buyerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed', 'Seller confirmed your payment. They will now send the tokens.', { tradeRef })
}

export async function markSellerTransferring(tradeRef: string, sellerId: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can mark transfer started', 403)
  if (trade.status !== 'payment_confirmed') throw new AppError('CONFLICT', `Cannot mark transferring in status: ${trade.status}`, 409)

  const proofDeadlineAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2h to submit token proof

  await db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'seller_transferring', proofDeadlineAt } })
  notify(trade.buyerId, 'CTM_SELLER_TRANSFERRING', 'Seller is transferring tokens', 'Seller has started the token transfer. Watch for incoming tokens.', { tradeRef })
}

export async function uploadTokenProof(tradeRef: string, sellerId: string, proofData: {
  fileUrl?: string
  fileHash?: string
  txHash?: string
  description?: string
  proofType: 'screenshot' | 'txhash' | 'uid_receipt' | 'video' | 'other'
}) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: { token: { select: { symbol: true, network: true, contractAddress: true, settlementType: true } } },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can upload token proof', 403)
  if (trade.status !== 'seller_transferring') throw new AppError('CONFLICT', `Cannot upload token proof in status: ${trade.status}`, 409)

  // ── On-chain verification for txhash proofs on ON_CHAIN settlements ──────────
  let txVerificationStatus: string | undefined
  let txVerificationDetails: Record<string, unknown> | undefined

  // Only on-chain-capable settlements verify the hash against a wallet. MANUAL
  // (exchange-UID / off-chain) settlements have no on-chain wallet to match —
  // verifying a "reference" against a UID would falsely reject the proof.
  const onChainCapable = trade.settlementType === 'ON_CHAIN' || trade.settlementType === 'HYBRID'

  if (proofData.proofType === 'txhash' && proofData.txHash && trade.token.network && onChainCapable) {
    const txHashNorm = proofData.txHash.trim().toLowerCase()

    // Duplicate guard across CTM proofs
    const dupeProof = await db.ctmTradeProof.findFirst({
      where: { txHash: txHashNorm, trade: { id: { not: trade.id } } },
      select: { tradeId: true },
    })
    if (dupeProof) {
      throw new AppError(
        'DUPLICATE_TX_HASH',
        'This transaction hash has already been submitted as proof for another trade',
        400,
      )
    }

    // Buyer's receiving address comes from buyerSettlementId (ON_CHAIN trades)
    const buyerWallet = trade.buyerSettlementId ?? ''

    if (buyerWallet) {
      try {
        const result = await verifyTradeTx(
          txHashNorm,
          trade.token.symbol,
          trade.token.network,
          trade.tokenAmount,
          buyerWallet,
        )
        txVerificationStatus = result.status
        txVerificationDetails = result.details

        logger.info(
          { tradeRef, txHash: txHashNorm, verificationStatus: result.status },
          'CTM uploadTokenProof: blockchain verification result',
        )

        if (HARD_REJECT_STATUSES.includes(result.status)) {
          const msgs: Record<string, string> = {
            reverted: 'Transaction was reverted on-chain — no tokens transferred.',
            mismatch_receiver: `Transaction sends to wrong address. ${result.message}`,
            mismatch_amount: `Amount sent is below the trade amount. ${result.message}`,
            not_found: 'Transaction not found on chain. Ensure it is confirmed and resubmit.',
            pending: 'Transaction is not yet confirmed. Wait for confirmation and resubmit.',
            failed: result.message,
          }
          throw new AppError('TX_VERIFICATION_FAILED', msgs[result.status] ?? result.message, 400)
        }
      } catch (err) {
        if (err instanceof AppError) throw err
        logger.warn({ err, tradeRef, txHash: txHashNorm }, 'CTM uploadTokenProof: verifier threw unexpectedly')
        txVerificationStatus = 'rpc_error'
      }
    } else {
      txVerificationStatus = 'skipped'
      txVerificationDetails = { reason: 'no_buyer_settlement_address' }
    }
  }

  const confirmDeadlineAt = new Date(Date.now() + 30 * 60 * 1000)

  await db.$transaction([
    db.ctmTrade.update({
      where: { id: trade.id },
      data: { status: 'proof_submitted', confirmDeadlineAt, proofDeadlineAt: null },
    }),
    db.ctmTradeProof.create({
      data: {
        tradeId: trade.id,
        uploadedBy: sellerId,
        proofType: proofData.proofType,
        fileUrl: proofData.fileUrl ?? null,
        fileHash: proofData.fileHash ?? null,
        txHash: proofData.txHash ? proofData.txHash.trim().toLowerCase() : null,
        txVerificationStatus: txVerificationStatus ?? null,
        txVerificationDetails: (txVerificationDetails as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        description: proofData.description ?? 'Token transfer proof',
      },
    }),
  ])

  notify(trade.buyerId, 'CTM_TOKEN_PROOF_SUBMITTED', 'Seller submitted transfer proof', 'Check your wallet and confirm receipt within 30 minutes.', { tradeRef })
}

export async function confirmReceipt(tradeRef: string, buyerId: string) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: {
      listing: true,
      proofs: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only buyer can confirm receipt', 403)
  if (trade.status !== 'proof_submitted') throw new AppError('CONFLICT', `Cannot confirm receipt in status: ${trade.status}`, 409)

  // Check the latest txhash proof's verification status
  const latestProof = trade.proofs[0]
  if (latestProof?.proofType === 'txhash' && latestProof.txVerificationStatus) {
    const vs = latestProof.txVerificationStatus
    if (!RELEASE_ALLOWED_STATUSES.includes(vs as never) && !ADMIN_REVIEW_STATUSES.includes(vs as never)) {
      throw new AppError(
        'TX_NOT_VERIFIED',
        `Cannot confirm receipt — transaction proof verification status is "${vs}". The transaction was rejected. Ask the seller to resubmit a valid transaction.`,
        400,
      )
    }
    if (ADMIN_REVIEW_STATUSES.includes(vs as never)) {
      throw new AppError(
        'TX_PENDING_REVIEW',
        'Cannot confirm receipt — this trade is pending admin verification of the transaction hash.',
        400,
      )
    }
  }

  await db.$transaction(async (tx: Tx) => {
    await tx.ctmTrade.update({
      where: { id: trade.id },
      data: { status: 'completed', completedAt: new Date(), confirmDeadlineAt: null },
    })

    // Update token stats
    await tx.ctmToken.update({
      where: { id: trade.tokenId },
      data: {
        totalTrades: { increment: 1 },
        totalVolumePkr: { increment: trade.fiatAmount },
        lastTradedAt: new Date(),
      },
    })

    // Update listing on completion: permanently reduce locked + total (do NOT restore availableAmount)
    if (trade.listingId) {
      await tx.ctmListing.update({
        where: { id: trade.listingId },
        data: {
          lockedAmount: { decrement: trade.tokenAmount },
          totalAmount: { decrement: trade.tokenAmount },
        },
      })
    }

    // Update merchant stats
    await tx.ctmMerchantProfile.updateMany({
      where: { userId: trade.sellerId },
      data: {
        totalCtmTrades: { increment: 1 },
        completedCtmTrades: { increment: 1 },
      },
    })

    // Update global TradeStats for buyer and seller so leaderboard reflects CTM trades
    for (const userId of [buyerId, trade.sellerId]) {
      const existing = await tx.tradeStats.findUnique({ where: { userId } })
      if (!existing) {
        await tx.tradeStats.create({
          data: {
            userId,
            totalTrades: 1,
            completedTrades: 1,
            completionRate: new Prisma.Decimal(1),
            totalVolumePKR: trade.fiatAmount,
          },
        })
      } else {
        const newTotal = existing.totalTrades + 1
        const newCompleted = existing.completedTrades + 1
        await tx.tradeStats.update({
          where: { userId },
          data: {
            totalTrades: newTotal,
            completedTrades: newCompleted,
            completionRate: new Prisma.Decimal(newCompleted).div(new Prisma.Decimal(newTotal)),
            totalVolumePKR: { increment: trade.fiatAmount },
          },
        })
      }
    }
  })

  // Trade completed cleanly → release the maker's bond (idempotent; no-op when off).
  await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
    logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond after CTM completion'),
  )

  queues.badgeRecalculate.add('recalc', { userId: buyerId }).catch(() => {})
  queues.badgeRecalculate.add('recalc', { userId: trade.sellerId }).catch(() => {})

  notify(trade.sellerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `Buyer confirmed receipt. Trade ${refLabel(trade.displayRef)} is complete.`, { tradeRef, displayRef: trade.displayRef })
  notify(buyerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `You confirmed receipt. Trade ${refLabel(trade.displayRef)} is complete.`, { tradeRef, displayRef: trade.displayRef })
}

export async function openDispute(tradeRef: string, userId: string, reason: string, description: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== userId && trade.sellerId !== userId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if ((ACTIVE_STATUSES as readonly string[]).indexOf(trade.status) === -1 || trade.status === 'awaiting_payment') {
    throw new AppError('CONFLICT', 'Cannot open dispute in current trade status', 409)
  }
  if (trade.dispute) throw new AppError('CONFLICT', 'Dispute already open for this trade', 409)

  await db.$transaction([
    db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'disputed' } }),
    db.ctmDispute.create({
      data: {
        tradeId: trade.id,
        openedById: userId,
        reason: reason as never,
        description,
      },
    }),
  ])

  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId
  notify(otherId, 'CTM_DISPUTE_OPENED', 'Dispute opened on trade', `A dispute has been opened on trade ${refLabel(trade.displayRef)}. An admin will review.`, { tradeRef, displayRef: trade.displayRef, dispute: true })
}

export async function cancelTrade(tradeRef: string, userId: string, reason: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== userId && trade.sellerId !== userId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (trade.status !== 'awaiting_payment') throw new AppError('CONFLICT', 'Can only cancel trade in awaiting_payment status', 409)

  await db.$transaction(async (tx: Tx) => {
    await tx.ctmTrade.update({
      where: { id: trade.id },
      data: { status: 'cancelled', cancelledBy: userId, cancelReason: reason, cancelledAt: new Date() },
    })

    if (trade.listingId) {
      await decrementLockedAmount(trade.listingId, trade.tokenAmount, tx)
    }
  })

  // Cancellation is not a maker fault → return the bond (idempotent; no-op when off).
  await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
    logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond after CTM cancel'),
  )

  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId
  notify(otherId, 'CTM_TRADE_CANCELLED', 'Trade cancelled', `Trade ${refLabel(trade.displayRef)} has been cancelled.`, { tradeRef, displayRef: trade.displayRef, reason })
}

export async function adminResolveDispute(adminId: string, tradeRef: string, data: {
  winner: 'buyer' | 'seller' | 'split'
  resolution: string
}) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!trade.dispute) throw new AppError('NOT_FOUND', 'No dispute found for this trade', 404)
  if (trade.status !== 'disputed') throw new AppError('CONFLICT', 'Trade is not in disputed status', 409)

  await db.$transaction([
    db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'dispute_resolved' } }),
    db.ctmDispute.update({
      where: { id: trade.dispute.id },
      data: {
        status: 'resolved',
        winner: data.winner as never,
        resolution: data.resolution,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    }),
  ])

  await db.auditLog.create({
    data: {
      actorId: adminId,
      action: 'CTM_DISPUTE_RESOLVED',
      metadata: { tradeRef, winner: data.winner, resolution: data.resolution } as JsonValue,
    },
  }).catch(() => {})

  // Maker collateral bond (Phase 5): seize to the winner if the maker lost, else
  // release. 'split' returns the bond. The helper looks up the maker from the
  // BondHold, so we just pass the winning/losing user ids.
  const winnerUserId = data.winner === 'buyer' ? trade.buyerId : data.winner === 'seller' ? trade.sellerId : null
  const loserUserId  = data.winner === 'buyer' ? trade.sellerId : data.winner === 'seller' ? trade.buyerId : null
  await resolveBondOnDispute({ tradeType: 'ctm', tradeId: trade.id, loserId: loserUserId, winnerId: winnerUserId })
    .catch((err) => logger.error({ err, tradeId: trade.id }, 'Failed to resolve maker bond on CTM dispute'))

  notify(trade.buyerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${refLabel(trade.displayRef)} has been resolved. Winner: ${data.winner}.`, { tradeRef, displayRef: trade.displayRef, dispute: true })
  notify(trade.sellerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${refLabel(trade.displayRef)} has been resolved. Winner: ${data.winner}.`, { tradeRef, displayRef: trade.displayRef, dispute: true })
}

/**
 * Admin posts a message into a CTM dispute thread — used to request more
 * evidence from the buyer/seller. Both parties are notified. Does not change
 * trade or dispute status.
 */
export async function adminAddDisputeMessage(adminId: string, tradeRef: string, message: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!trade.dispute) throw new AppError('NOT_FOUND', 'No dispute found for this trade', 404)

  const msg = await db.ctmDisputeMessage.create({
    data: { disputeId: trade.dispute.id, senderId: adminId, message },
  })

  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_DISPUTE_MESSAGE', targetType: 'CtmTrade', targetId: trade.id, metadata: { tradeRef, message } as JsonValue },
  }).catch(() => {})

  const label = trade.displayRef ?? 'your CTM trade'
  const body = `Trade ${label} — an admin asked for more information: ${message}. Tap to respond.`
  const meta = { tradeRef, displayRef: trade.displayRef, dispute: true }
  notify(trade.buyerId, 'CTM_DISPUTE_MESSAGE', 'Admin requested additional evidence', body, meta)
  notify(trade.sellerId, 'CTM_DISPUTE_MESSAGE', 'Admin requested additional evidence', body, meta)

  return msg
}

export async function adminConfirmPayment(adminId: string, tradeRef: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.status !== 'payment_uploaded') throw new AppError('CONFLICT', `Cannot confirm payment in status: ${trade.status}`, 409)

  await db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'payment_confirmed' } })
  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_ADMIN_CONFIRM_PAYMENT', metadata: { tradeRef } as JsonValue },
  }).catch(() => {})

  notify(trade.buyerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed by admin', 'An admin has confirmed your payment.', { tradeRef })
  notify(trade.sellerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed by admin', 'An admin has confirmed the buyer payment. Please send the tokens.', { tradeRef })
}

export async function getAllTradesAdmin(filters: { status?: string; search?: string; token?: string; minAmount?: number; maxAmount?: number; page?: number; limit?: number } = {}) {
  const { status, search, token, minAmount, maxAmount, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit
  const where: Record<string, unknown> = {}
  if (status) where.status = status

  const and: Record<string, unknown>[] = []
  if (search) {
    const s = search.trim()
    // Resolve users matching the term so ref OR username search both work.
    const users = await db.user.findMany({
      where: { OR: [{ username: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }] },
      select: { id: true }, take: 100,
    })
    const userIds = users.map((u) => u.id)
    and.push({
      OR: [
        { tradeRef: { contains: s, mode: 'insensitive' } },
        { displayRef: { contains: s, mode: 'insensitive' } },
        { token: { symbol: { contains: s, mode: 'insensitive' } } },
        { token: { name: { contains: s, mode: 'insensitive' } } },
        { buyerId: { in: userIds } },
        { sellerId: { in: userIds } },
      ],
    })
  }
  if (token) and.push({ token: { OR: [{ symbol: { contains: token, mode: 'insensitive' } }, { id: token }] } })
  if (minAmount != null && !Number.isNaN(minAmount)) and.push({ fiatAmount: { gte: minAmount } })
  if (maxAmount != null && !Number.isNaN(maxAmount)) and.push({ fiatAmount: { lte: maxAmount } })
  if (and.length) where.AND = and

  const [trades, total] = await Promise.all([
    db.ctmTrade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, name: true, symbol: true } },
        buyer: { select: { id: true, username: true } },
        seller: { select: { id: true, username: true } },
        dispute: { select: { id: true, status: true, reason: true } },
      },
    }),
    db.ctmTrade.count({ where }),
  ])

  return { trades, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function createTradeFromListing(buyerId: string, listingId: string, data: {
  paymentMethod?: string
  paymentMethods?: string[]  // BUY listings: seller selects multiple receiving accounts
  buyerSettlementId?: string
  buyerPaymentMethodId?: string  // SELL listings: buyer's own account they'll pay FROM
  tokenAmount?: number
}) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { token: true, merchantProfile: { include: { user: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  if (!listing.merchantProfile.isActive) throw new AppError('CONFLICT', 'Merchant is not active', 409)
  if (listing.merchantProfile.userId === buyerId) throw new AppError('CONFLICT', 'Cannot trade with yourself', 409)
  if (listing.availableAmount.lte(0)) throw new AppError('CONFLICT', 'Listing has no available tokens', 409)

  // BUY listings: listing creator = buyer (pays PKR), trade taker = seller (sends tokens, receives PKR).
  // SELL listings: listing creator = seller (sends tokens), trade taker = buyer (pays PKR).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isBuyListing = (listing as any).side === 'buy'
  const actualBuyerId = isBuyListing ? listing.merchantProfile.userId : buyerId
  const actualSellerId = isBuyListing ? buyerId : listing.merchantProfile.userId

  // SELL listings: taker (buyer) picks one of the listing's accepted payment methods.
  // BUY listings: taker (seller) provides one or more of their own receiving accounts.
  let primaryPaymentMethodId: string
  let resolvedPaymentMethodIds: string[]
  if (!isBuyListing) {
    if (!data.paymentMethod) throw new AppError('VALIDATION_ERROR', 'paymentMethod is required', 400)
    if (!listing.paymentMethods.includes(data.paymentMethod)) {
      throw new AppError('CONFLICT', 'Payment method not supported by this listing', 409)
    }
    primaryPaymentMethodId = data.paymentMethod
    resolvedPaymentMethodIds = [data.paymentMethod]
  } else {
    const ids = data.paymentMethods?.length ? data.paymentMethods : (data.paymentMethod ? [data.paymentMethod] : [])
    if (ids.length === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one payment receiving account', 400)
    primaryPaymentMethodId = ids[0]!
    resolvedPaymentMethodIds = ids
  }

  // Token amount is required — takers always specify quantity in tokens.
  if (data.tokenAmount === undefined) throw new AppError('VALIDATION_ERROR', 'tokenAmount is required', 400)
  const tradeTokenAmount = new Prisma.Decimal(data.tokenAmount)
  if (tradeTokenAmount.lte(0)) throw new AppError('VALIDATION_ERROR', 'Token amount must be greater than 0', 400)
  if (tradeTokenAmount.gt(listing.availableAmount)) throw new AppError('VALIDATION_ERROR', 'Requested amount exceeds available listing amount', 400)
  if (tradeTokenAmount.lt(listing.minOrderTokens)) throw new AppError('VALIDATION_ERROR', `Minimum order is ${listing.minOrderTokens.toString()} ${listing.token.symbol}`, 400)
  if (tradeTokenAmount.gt(listing.maxOrderTokens)) throw new AppError('VALIDATION_ERROR', `Maximum order is ${listing.maxOrderTokens.toString()} ${listing.token.symbol}`, 400)

  // Non-custodial early-access per-order cap, expressed in USDT-equivalent and
  // tier-aware (taker = buyerId). L1 default 50 USDT-equiv, L2 default unlimited.
  // Converts the PKR order value using the platform USDT→PKR rate; if that rate
  // is unavailable the cap is skipped (fail-open) rather than blocking trades.
  if (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)) {
    const taker = await db.user.findUnique({ where: { id: buyerId }, select: { kycLevel: true } })
    const capUsdt = taker?.kycLevel === 'enhanced'
      ? await getNumberConfig('noncustodial_max_order_usdt_l2', 500)
      : await getNumberConfig('noncustodial_max_order_usdt_l1', 50)
    if (capUsdt > 0) {
      const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
      if (usdtPkr > 0) {
        const orderUsdtEquiv = listing.pricePerUnit.mul(tradeTokenAmount).toNumber() / usdtPkr
        if (orderUsdtEquiv > capUsdt) {
          throw new AppError('ORDER_TOO_LARGE', `During early access, your maximum order is ${capUsdt} USDT-equivalent.`, 400)
        }
      }
    }
  }

  // Snapshot the payment account(s) that will RECEIVE the PKR payment (always the seller).
  // For SELL listings: single account — seller = listing creator.
  // For BUY listings: one or more accounts — seller = trade taker (buyerId param).
  const PM_LABELS: Record<string, string> = { jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay', nayapay: 'NayaPay', bank_transfer: 'Bank Transfer' }
  const paymentMethodOwnerId = isBuyListing ? buyerId : listing.merchantProfile.userId

  function buildAccountSnapshot(pm: { type: string; accountName: string; bankName: string | null; mobileNumber: string | null; ibanNumber: string | null; accountNumber: string | null }) {
    return {
      type: pm.type as string,
      label: pm.type === 'bank_transfer' ? (pm.bankName ?? 'Bank Transfer') : (PM_LABELS[pm.type] ?? pm.type),
      accountName: pm.accountName,
      ...(pm.mobileNumber ? { mobileNumber: pm.mobileNumber } : {}),
      ...(pm.bankName ? { bankName: pm.bankName } : {}),
      ...(pm.ibanNumber ? { ibanNumber: pm.ibanNumber } : {}),
      ...(pm.accountNumber ? { accountNumber: pm.accountNumber } : {}),
    }
  }

  let sellerPaymentSnapshot: Record<string, unknown>
  if (isBuyListing && resolvedPaymentMethodIds.length > 1) {
    // Multi-account: seller chose multiple receiving accounts
    const methods = await db.paymentMethod.findMany({
      where: { id: { in: resolvedPaymentMethodIds }, userId: paymentMethodOwnerId },
    })
    if (methods.length !== resolvedPaymentMethodIds.length) {
      throw new AppError('CONFLICT', 'One or more payment methods not found or do not belong to you', 409)
    }
    // Store as { accounts: [...] } — trade room renders all, buyer picks one to pay to
    sellerPaymentSnapshot = { accounts: methods.map(buildAccountSnapshot) }
  } else {
    const sellerPaymentMethod = await db.paymentMethod.findFirst({
      where: { id: primaryPaymentMethodId, userId: paymentMethodOwnerId },
    })
    if (!sellerPaymentMethod) throw new AppError('CONFLICT', 'Payment method not found or does not belong to you', 409)
    sellerPaymentSnapshot = buildAccountSnapshot(sellerPaymentMethod)
  }

  // SELL listings only: snapshot the buyer's "pay from" account so the seller can see it in the trade room.
  let buyerPaymentSnapshot: Record<string, unknown> | null = null
  if (!isBuyListing && data.buyerPaymentMethodId) {
    const buyerPm = await db.paymentMethod.findFirst({
      where: { id: data.buyerPaymentMethodId, userId: buyerId },
    })
    if (buyerPm) buyerPaymentSnapshot = buildAccountSnapshot(buyerPm)
  }

  // Buyer's token receiving address:
  // For SELL listings: provided by trade taker (buyer) at trade start.
  // For BUY listings: already stored on the listing (listing creator's address).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actualBuyerSettlementId = isBuyListing ? ((listing as any).settlementMethod ?? null) : (data.buyerSettlementId ?? null)

  // Guardrail: if the admin configured an address pattern for this token, the
  // buyer's receiving address must match it — so a wrong-chain address (e.g. an
  // EVM 0x… where a Sidra address is expected) can't be used. Shared with
  // createListing so an ad that passes creation also passes trade start. Only
  // applied to blockchain deliveries (email/username carry a different value).
  assertTokenAddressFormat(
    listing.token,
    actualBuyerSettlementId ? String(actualBuyerSettlementId) : null,
    (listing as { tokenDeliveryType?: string | null }).tokenDeliveryType,
  )

  const expiresAt = new Date(Date.now() + (listing.tradeWindowMins ?? 45) * 60 * 1000)

  // Maker collateral bond (non-custodial Phase 5): the LISTING CREATOR (maker)
  // posts the bond, regardless of buy/sell side. CTM is priced in PKR, so the
  // bond is computed on the USDT-equivalent via the platform USDT→PKR rate. If
  // that rate is unavailable we skip the bond (fail-open, consistent with the
  // order-cap) rather than block trading.
  const makerId = listing.merchantProfile.userId
  const bondCfg = await getBondConfig()
  let bondUsdtEquiv = 0
  if (bondCfg.enabled) {
    const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
    if (usdtPkr > 0) {
      bondUsdtEquiv = listing.pricePerUnit.mul(tradeTokenAmount).toNumber() / usdtPkr
    } else {
      logger.warn({ listingId }, 'maker bond skipped for CTM trade — USDT/PKR rate unavailable')
    }
  }
  const willBond = bondCfg.enabled && bondUsdtEquiv > 0

  const created = await db.$transaction(async (tx: Tx) => {
    // Atomic availability check: only lock if availableAmount >= requested amount (prevents race condition)
    const updated = await tx.ctmListing.updateMany({
      where: { id: listing.id, availableAmount: { gte: tradeTokenAmount } },
      data: {
        availableAmount: { decrement: tradeTokenAmount },
        lockedAmount: { increment: tradeTokenAmount },
      },
    })
    if (updated.count === 0) throw new AppError('CONFLICT', 'Listing is no longer available for trading', 409)

    const isOnChain = listing.settlementType === 'ON_CHAIN'
    const escrowAddress = isOnChain ? (process.env.PLATFORM_USDT_WALLET ?? null) : null
    const escrowCurrency = isOnChain ? (process.env.PLATFORM_ESCROW_CURRENCY ?? 'USDT_TRC20') : null
    const escrowAmount = isOnChain ? listing.pricePerUnit.mul(tradeTokenAmount) : null

    const fiatAmount = listing.pricePerUnit.mul(tradeTokenAmount)
    // Platform fee: configurable via env (default 0.5% of PKR amount)
    const feePct = parseFloat(process.env.CTM_PLATFORM_FEE_PCT ?? '0.5') / 100
    const platformFeePkr = fiatAmount.mul(feePct)

    const trade = await tx.ctmTrade.create({
      data: {
        displayRef: await generateCtmDisplayRef(tx),
        listingId: listing.id,
        buyerId: actualBuyerId,
        sellerId: actualSellerId,
        tokenId: listing.tokenId,
        settlementType: listing.settlementType,
        tokenAmount: tradeTokenAmount,
        pricePerUnit: listing.pricePerUnit,
        fiatAmount,
        paymentMethod: primaryPaymentMethodId,
        settlementMethod: listing.settlementMethod,
        buyerSettlementId: actualBuyerSettlementId,
        sellerPaymentSnapshot: sellerPaymentSnapshot as never,
        ...(buyerPaymentSnapshot ? { buyerPaymentSnapshot: buyerPaymentSnapshot as never } : {}),
        status: 'awaiting_payment',
        expiresAt,
        platformFeePkr,
        ...(escrowAddress ? { escrowAddress, escrowCurrency, escrowAmount } : {}),
      },
    })

    // Maker collateral bond — lock the maker's USDT bond in the SAME transaction
    // (placed last so nothing can fail after it). Throws INSUFFICIENT_BOND →
    // the whole trade creation, incl. the listing availability decrement, rolls
    // back atomically.
    if (willBond) {
      await lockMakerBondTx(
        tx,
        { tradeType: 'ctm', tradeId: trade.id, makerId, tradeUsdt: bondUsdtEquiv },
        bondCfg,
      )
    }

    // Notify the listing creator (buyer for BUY listings, seller for SELL listings)
    notify(listing.merchantProfile.userId, 'ctm_trade_created', 'New CTM Trade', `New trade for your ${listing.token.symbol} listing`, { tradeRef: trade.tradeRef })

    return trade
  })

  if (willBond) {
    void recordAuditLog(makerId, 'BOND_LOCKED', 'BondHold', `ctm:${created.id}`, {
      tradeType: 'ctm', tradeId: created.id, amountUsdt: bondUsdtEquiv.toString(),
    })
    logger.info({ tradeId: created.id, makerId, amountUsdt: bondUsdtEquiv }, 'Maker bond locked (CTM)')
  }

  return created
}

export async function sendMessage(tradeRef: string, senderId: string, message: string, attachmentUrl?: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== senderId && trade.sellerId !== senderId) throw new AppError('FORBIDDEN', 'Access denied', 403)

  return db.ctmTradeMessage.create({
    data: { tradeId: trade.id, senderId, message, attachmentUrl: attachmentUrl ?? null },
  })
}

export async function getMessages(tradeRef: string, userId: string, role: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!isParticipant(trade, userId, role)) throw new AppError('FORBIDDEN', 'Access denied', 403)

  return db.ctmTradeMessage.findMany({
    where: { tradeId: trade.id },
    orderBy: { createdAt: 'asc' },
  })
}

export async function rateTrade(tradeRef: string, raterId: string, data: {
  rating: number
  comment?: string
  tags?: string[]
}) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== raterId && trade.sellerId !== raterId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (trade.status !== 'completed') throw new AppError('CONFLICT', 'Can only rate completed trades', 409)

  const ratedUserId = trade.buyerId === raterId ? trade.sellerId : trade.buyerId

  const existing = await db.ctmTradeRating.findUnique({ where: { tradeId_ratedByUserId: { tradeId: trade.id, ratedByUserId: raterId } } })
  if (existing) throw new AppError('CONFLICT', 'You have already rated this trade', 409)

  const rating = await db.ctmTradeRating.create({
    data: {
      tradeId: trade.id,
      ratedByUserId: raterId,
      ratedUserId,
      rating: data.rating,
      comment: data.comment ?? null,
      tags: data.tags ?? [],
    },
  })

  // Update merchant avg rating
  const allRatings = await db.ctmTradeRating.aggregate({
    where: { ratedUserId },
    _avg: { rating: true },
  })
  if (allRatings._avg.rating !== null) {
    await db.ctmMerchantProfile.updateMany({
      where: { userId: ratedUserId },
      data: { ctmAvgRating: new Prisma.Decimal(allRatings._avg.rating) },
    })
  }

  return rating
}

export async function selectTradePaymentAccount(tradeRef: string, buyerId: string, accountIndex: number) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only the buyer can select the payment account', 403)
  if (trade.status !== 'awaiting_payment') throw new AppError('CONFLICT', 'Payment account can only be selected while awaiting payment', 409)

  const snapshot = trade.sellerPaymentSnapshot as Record<string, unknown> | null
  if (!snapshot || !Array.isArray(snapshot.accounts)) {
    throw new AppError('CONFLICT', 'This trade does not require a payment account selection', 409)
  }
  if (snapshot.selectedIdx !== undefined) {
    throw new AppError('CONFLICT', 'Payment account is already selected for this trade', 409)
  }
  if (accountIndex < 0 || accountIndex >= (snapshot.accounts as unknown[]).length) {
    throw new AppError('VALIDATION_ERROR', 'Invalid account index', 400)
  }

  const selectedAccount = (snapshot.accounts as Record<string, string>[])[accountIndex]!
  const updatedSnapshot = { ...snapshot, selectedIdx: accountIndex }

  await db.ctmTrade.update({
    where: { tradeRef },
    data: { sellerPaymentSnapshot: updatedSnapshot as never },
  })

  notify(
    trade.sellerId,
    'CTM_PAYMENT_METHOD_SELECTED',
    'Buyer selected payment method',
    `Buyer selected ${selectedAccount.label} for trade ${tradeRef}. You will receive payment in your ${selectedAccount.label} account.`,
    { tradeRef },
  )

  return { selectedIdx: accountIndex, selectedAccount }
}
