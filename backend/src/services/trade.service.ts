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
  // Idempotency check
  const idempKey = `idempotency:trade:${buyerId}:${adId}:${data.amount}:${data.paymentMethod}`
  const existing = await redis.get(idempKey)
  if (existing) {
    const trade = await db.trade.findUnique({ where: { id: existing } })
    if (trade) return trade
  }

  const trade = await db.$transaction(async (tx: Tx) => {
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

  // Store idempotency key (5 min TTL)
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
    data: { status: 'payment_uploaded', paymentProofUrl: proofUrl },
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

export async function confirmPayment(tradeId: string, actorId: string, role: string) {
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
      data: { status: 'payment_confirmed' },
    })
  })

  notify(updated.buyerId, 'trade', 'Payment Confirmed', 'The seller has confirmed your payment. Crypto will be sent soon.', { tradeId }, tradeId)
  return updated
}

export async function markCryptoSent(tradeId: string, sellerId: string, txHash: string) {
  const updated = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; sellerId: string; buyerId: string }>>`
      SELECT id, status, "sellerId", "buyerId" FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `
    const trade = rows[0]
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only the seller can mark crypto as sent', 403)
    if (trade.status !== 'payment_confirmed') {
      throw new AppError('INVALID_STATUS', `Cannot mark crypto sent for trade in status: ${trade.status}`, 400)
    }

    return tx.trade.update({
      where: { id: tradeId },
      data: { status: 'crypto_sent', sellerTxHash: txHash },
    })
  })

  notify(updated.buyerId, 'trade', 'Crypto Is on the Way', 'The seller has sent the crypto. Please verify and release once received.', { tradeId }, tradeId)
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
  })

  // Queue badge recalculation for both
  await queues.badgeRecalculate.add('recalculate', { userId: buyerId })
  await queues.badgeRecalculate.add('recalculate', { userId: tradeDetails.sellerId })

  // Queue referral payout if first trade bonus not yet paid
  if (!tradeDetails.buyer.firstTradeBonusPaid) {
    await queues.referralPayout.add('first-trade', { userId: buyerId, tradeId })
  }

  notify(tradeDetails.sellerId, 'trade', 'Trade Completed', 'The buyer has released the crypto. Trade is complete.', { tradeId }, tradeId)

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

    // Restore buyer dailyBuyUsed
    await tx.user.update({
      where: { id: trade.buyerId },
      data: { dailyBuyUsed: { decrement: trade.fiatAmount } },
    })
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

  const disputeStatuses = ['payment_uploaded', 'payment_confirmed']
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
  // Notify admins via a system user placeholder — admin panel polls disputes directly
  notify(openedById, 'dispute', 'Dispute Submitted', 'Your dispute has been submitted and will be reviewed by an admin.', { tradeId, disputeId: dispute.id }, tradeId)

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

  // Notify the other party so their SSE feed fires immediately
  const recipientId = trade.buyerId === senderId ? trade.sellerId : trade.buyerId
  const senderLabel = sender?.username ?? 'Someone'
  const preview = content.length > 60 ? content.slice(0, 57) + '…' : content
  notify(recipientId, 'trade', 'New Message', `${senderLabel}: ${preview}`, { tradeId }, tradeId)

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

  // Update ratee's avgRating in TradeStats
  const allRatings = await db.tradeRating.findMany({
    where: { ratedUserId: rateeId },
    select: { rating: true },
  })
  const totalRatings = allRatings.length
  const avgRating = allRatings.reduce((sum, r) => sum + r.rating, 0) / totalRatings

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
        buyer: { select: { id: true, username: true } },
        seller: { select: { id: true, username: true } },
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
          id: true, username: true, kycStatus: true,
          tradeStats: { select: { badge: true, badgeLabel: true, trustScore: true, completedTrades: true, completionRate: true } },
        },
      },
      seller: {
        select: {
          id: true, username: true, kycStatus: true,
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

  return trade
}
