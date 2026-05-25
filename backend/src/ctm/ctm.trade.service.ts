import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { decrementLockedAmount } from './ctm.listing.service'
import { queues } from '../queues/definitions'

type JsonValue = Prisma.InputJsonValue
type Tx = Prisma.TransactionClient

const ACTIVE_STATUSES = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] as const

function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  db.notification
    .create({ data: { userId, type, title, body, metadata: metadata as JsonValue } })
    .catch(() => {})
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
      buyer: { select: { id: true, username: true } },
      seller: { select: { id: true, username: true } },
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
  return { ...trade, ratedByMe: !!ratedByMeRecord }
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
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can upload token proof', 403)
  if (trade.status !== 'seller_transferring') throw new AppError('CONFLICT', `Cannot upload token proof in status: ${trade.status}`, 409)

  const confirmDeadlineAt = new Date(Date.now() + 30 * 60 * 1000) // buyer has 30 min to confirm

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
        txHash: proofData.txHash ?? null,
        description: proofData.description ?? 'Token transfer proof',
      },
    }),
  ])

  notify(trade.buyerId, 'CTM_TOKEN_PROOF_SUBMITTED', 'Seller submitted transfer proof', 'Check your wallet and confirm receipt within 30 minutes.', { tradeRef })
}

export async function confirmReceipt(tradeRef: string, buyerId: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { listing: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only buyer can confirm receipt', 403)
  if (trade.status !== 'proof_submitted') throw new AppError('CONFLICT', `Cannot confirm receipt in status: ${trade.status}`, 409)

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
  })

  queues.badgeRecalculate.add('recalc', { userId: buyerId }).catch(() => {})
  queues.badgeRecalculate.add('recalc', { userId: trade.sellerId }).catch(() => {})

  notify(trade.sellerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `Buyer confirmed receipt. Trade ${tradeRef} is complete.`, { tradeRef })
  notify(buyerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `You confirmed receipt. Trade ${tradeRef} is complete.`, { tradeRef })
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
  notify(otherId, 'CTM_DISPUTE_OPENED', 'Dispute opened on trade', `A dispute has been opened on trade ${tradeRef}. An admin will review.`, { tradeRef })
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

  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId
  notify(otherId, 'CTM_TRADE_CANCELLED', 'Trade cancelled', `Trade ${tradeRef} has been cancelled.`, { tradeRef, reason })
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

  notify(trade.buyerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${tradeRef} has been resolved. Winner: ${data.winner}.`, { tradeRef })
  notify(trade.sellerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${tradeRef} has been resolved. Winner: ${data.winner}.`, { tradeRef })
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

export async function getAllTradesAdmin(filters: { status?: string; page?: number; limit?: number } = {}) {
  const { status, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit
  const where: Record<string, unknown> = {}
  if (status) where.status = status

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
  paymentMethod: string
  buyerSettlementId?: string
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
  if (!listing.paymentMethods.includes(data.paymentMethod)) throw new AppError('CONFLICT', 'Payment method not supported by this listing', 409)
  if (listing.availableAmount.lte(0)) throw new AppError('CONFLICT', 'Listing has no available tokens', 409)

  // Determine the trade token amount (partial fill or full listing)
  const tradeTokenAmount = data.tokenAmount
    ? new Prisma.Decimal(data.tokenAmount)
    : listing.availableAmount
  if (tradeTokenAmount.lte(0)) throw new AppError('VALIDATION_ERROR', 'Token amount must be greater than 0', 400)
  if (tradeTokenAmount.gt(listing.availableAmount)) throw new AppError('VALIDATION_ERROR', 'Requested amount exceeds available listing amount', 400)

  const fiatRequired = listing.pricePerUnit.mul(tradeTokenAmount)
  if (fiatRequired.lt(listing.minOrderPkr)) throw new AppError('VALIDATION_ERROR', `Minimum order is PKR ${listing.minOrderPkr}`, 400)
  if (fiatRequired.gt(listing.maxOrderPkr)) throw new AppError('VALIDATION_ERROR', `Maximum order is PKR ${listing.maxOrderPkr}`, 400)

  // Fetch and snapshot seller's payment account details
  const sellerPaymentMethod = await db.paymentMethod.findFirst({
    where: { id: data.paymentMethod, userId: listing.merchantProfile.userId },
  })
  if (!sellerPaymentMethod) throw new AppError('CONFLICT', 'Seller payment method no longer available', 409)

  const PM_LABELS: Record<string, string> = { jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay', nayapay: 'NayaPay', bank_transfer: 'Bank Transfer' }
  const sellerPaymentSnapshot = {
    type: sellerPaymentMethod.type as string,
    label: sellerPaymentMethod.type === 'bank_transfer' ? (sellerPaymentMethod.bankName ?? 'Bank Transfer') : (PM_LABELS[sellerPaymentMethod.type] ?? sellerPaymentMethod.type),
    accountName: sellerPaymentMethod.accountName,
    ...(sellerPaymentMethod.mobileNumber ? { mobileNumber: sellerPaymentMethod.mobileNumber } : {}),
    ...(sellerPaymentMethod.bankName ? { bankName: sellerPaymentMethod.bankName } : {}),
    ...(sellerPaymentMethod.ibanNumber ? { ibanNumber: sellerPaymentMethod.ibanNumber } : {}),
    ...(sellerPaymentMethod.accountNumber ? { accountNumber: sellerPaymentMethod.accountNumber } : {}),
  }

  const expiresAt = new Date(Date.now() + (listing.tradeWindowMins ?? 45) * 60 * 1000)

  return db.$transaction(async (tx: Tx) => {
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
        listingId: listing.id,
        buyerId,
        sellerId: listing.merchantProfile.userId,
        tokenId: listing.tokenId,
        settlementType: listing.settlementType,
        tokenAmount: tradeTokenAmount,
        pricePerUnit: listing.pricePerUnit,
        fiatAmount,
        paymentMethod: data.paymentMethod,
        settlementMethod: listing.settlementMethod,
        buyerSettlementId: data.buyerSettlementId ?? null,
        sellerPaymentSnapshot: sellerPaymentSnapshot as never,
        status: 'awaiting_payment',
        expiresAt,
        platformFeePkr,
        ...(escrowAddress ? { escrowAddress, escrowCurrency, escrowAmount } : {}),
      },
    })

    notify(listing.merchantProfile.userId, 'ctm_trade_created', 'New CTM Trade', `New trade for your ${listing.token.symbol} listing`, { tradeRef: trade.tradeRef })

    return trade
  })
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
