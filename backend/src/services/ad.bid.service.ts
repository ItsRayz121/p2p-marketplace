import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { notify } from '../lib/notify'
import { generateOrderRef } from '../lib/hash'

type Tx = Prisma.TransactionClient

type TradeStatusLiteral = 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed'
const ACTIVE_TRADE_STATUSES: TradeStatusLiteral[] = ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent']

export async function placeBid(
  bidderId: string,
  adId: string,
  data: { pricePerUnit: number; usdtAmount: number; message?: string | undefined },
) {
  const ad = await db.ad.findUnique({ where: { id: adId }, include: { user: { select: { id: true, username: true } } } })
  if (!ad) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (ad.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  if (ad.userId === bidderId) throw new AppError('CONFLICT', 'Cannot bid on your own listing', 409)

  const usdtAmount = new Prisma.Decimal(data.usdtAmount)
  if (usdtAmount.lte(0)) throw new AppError('VALIDATION_ERROR', 'USDT amount must be greater than 0', 400)
  if (usdtAmount.gt(ad.availableAmount)) throw new AppError('VALIDATION_ERROR', 'Amount exceeds available listing amount', 400)
  if (usdtAmount.lt(ad.minOrder)) throw new AppError('VALIDATION_ERROR', `Minimum order is ${ad.minOrder} USDT`, 400)
  if (usdtAmount.gt(ad.maxOrder)) throw new AppError('VALIDATION_ERROR', `Maximum order is ${ad.maxOrder} USDT`, 400)

  const pricePerUnit = new Prisma.Decimal(data.pricePerUnit)
  if (pricePerUnit.lte(0)) throw new AppError('VALIDATION_ERROR', 'Bid price must be greater than 0', 400)

  const fiatAmount = pricePerUnit.mul(usdtAmount)
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000)

  const bid = await db.adBid.create({
    data: { adId, bidderId, pricePerUnit, usdtAmount, fiatAmount, message: data.message ?? null, status: 'pending', expiresAt },
  })

  notify(
    ad.userId,
    'AD_BID_RECEIVED',
    'New bid on your listing',
    `Someone offered PKR ${pricePerUnit.toNumber().toLocaleString()} per USDT on your listing`,
    { bidId: bid.id, adId },
  )

  return bid
}

export async function acceptAdBid(adOwnerUserId: string, bidId: string) {
  const bid = await db.adBid.findUnique({
    where: { id: bidId },
    include: { ad: true, bidder: { select: { id: true, username: true } } },
  })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.ad.userId !== adOwnerUserId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Bid is already ${bid.status}`, 409)
  if (new Date() > bid.expiresAt) throw new AppError('CONFLICT', 'Bid has expired', 409)

  const newExpiry = new Date(Date.now() + 30 * 60 * 1000)

  await db.$transaction(async (tx: Tx) => {
    const updated = await tx.ad.updateMany({
      where: { id: bid.adId, availableAmount: { gte: bid.usdtAmount } },
      data: { availableAmount: { decrement: bid.usdtAmount } },
    })
    if (updated.count === 0) throw new AppError('CONFLICT', 'Listing no longer has enough available amount', 409)

    await tx.adBid.updateMany({
      where: { adId: bid.adId, status: 'pending', id: { not: bidId } },
      data: { status: 'rejected' },
    })

    await tx.adBid.update({ where: { id: bidId }, data: { status: 'accepted_pending_buyer', expiresAt: newExpiry } })
  })

  notify(bid.bidderId, 'AD_BID_ACCEPTED_PENDING', 'Bid accepted — action needed',
    `Your bid was accepted! Complete your payment details within 30 minutes to open the trade.`,
    { bidId, adId: bid.adId })

  return { status: 'accepted_pending_buyer', bidId, expiresAt: newExpiry }
}

export async function confirmBidDetails(
  bidderId: string,
  bidId: string,
  data: { paymentMethod: string; buyerUsdtAddress?: string | undefined },
) {
  const bid = await db.adBid.findUnique({
    where: { id: bidId },
    include: { ad: true, bidder: { select: { id: true } } },
  })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.bidderId !== bidderId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'accepted_pending_buyer') throw new AppError('CONFLICT', 'Bid is not awaiting your confirmation', 409)
  if (new Date() > bid.expiresAt) throw new AppError('CONFLICT', 'Bid confirmation window has expired', 409)

  if (!data.paymentMethod) throw new AppError('VALIDATION_ERROR', 'Select a payment method', 400)

  const ad = bid.ad
  const isSellAd = ad.side === 'sell'
  // SELL ad: ad owner sells USDT → bidder = buyer → needs USDT receiving address
  if (isSellAd && !data.buyerUsdtAddress?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'Enter your USDT receiving address', 400)
  }

  const buyerId = isSellAd ? bid.bidderId : ad.userId
  const sellerId = isSellAd ? ad.userId : bid.bidderId
  const expiresAt = new Date(Date.now() + (ad.tradeWindow ?? 30) * 60 * 1000)
  const orderRef = generateOrderRef('TRD')

  return db.$transaction(async (tx: Tx) => {
    // Check buyer standing
    const [buyerRow] = await tx.$queryRaw<Array<{
      isBanned: boolean; isSuspended: boolean; kycStatus: string
      dailyBuyUsed: Prisma.Decimal; dailyBuyLimit: Prisma.Decimal; dailyBuyReset: Date | null
    }>>`
      SELECT "isBanned", "isSuspended", "kycStatus", "dailyBuyUsed", "dailyBuyLimit", "dailyBuyReset"
      FROM "User" WHERE id = ${buyerId} FOR UPDATE
    `
    if (!buyerRow) throw new AppError('NOT_FOUND', 'Buyer not found', 404)
    if (buyerRow.isBanned) throw new AppError('ACCOUNT_BANNED', 'Account is banned', 403)
    if (buyerRow.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended', 403)
    if (buyerRow.kycStatus !== 'approved') throw new AppError('KYC_REQUIRED', 'KYC verification required to trade', 403)

    const now = new Date()
    const needsReset = buyerRow.dailyBuyReset && now > buyerRow.dailyBuyReset
    const effectiveDailyUsed = needsReset ? new Prisma.Decimal(0) : new Prisma.Decimal(buyerRow.dailyBuyUsed)
    if (effectiveDailyUsed.add(bid.fiatAmount).gt(new Prisma.Decimal(buyerRow.dailyBuyLimit))) {
      throw new AppError('DAILY_LIMIT_EXCEEDED', 'Daily buy limit would be exceeded', 400)
    }

    const resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    await tx.user.update({
      where: { id: buyerId },
      data: {
        dailyBuyUsed: needsReset ? bid.fiatAmount : { increment: bid.fiatAmount },
        ...(needsReset ? { dailyBuyReset: resetAt } : {}),
      },
    })

    const trade = await tx.trade.create({
      data: {
        orderRef,
        adId: bid.adId,
        adBidId: bid.id,
        buyerId,
        sellerId,
        coin: ad.coin,
        network: ad.network,
        amount: bid.usdtAmount,
        price: bid.pricePerUnit,
        fiatAmount: bid.fiatAmount,
        paymentMethod: data.paymentMethod,
        buyerWalletAddress: data.buyerUsdtAddress ?? '',
        buyerDeliveryMethod: data.buyerUsdtAddress
          ? (data.buyerUsdtAddress.includes(':') ? (data.buyerUsdtAddress.split(':')[0] ?? 'wallet_blockchain') : 'wallet_blockchain')
          : null,
        status: 'payment_pending',
        expiresAt,
      },
    })

    await tx.tradeMessage.create({
      data: { tradeId: trade.id, senderId: buyerId, message: 'Trade opened via bid. Please upload payment proof within the trade window.' },
    })

    await tx.adBid.update({ where: { id: bidId }, data: { status: 'accepted', paymentMethod: data.paymentMethod, buyerUsdtAddress: data.buyerUsdtAddress ?? null } })

    const newAdStatus = ad.availableAmount.lte(0) ? 'completed' : 'active'
    if (newAdStatus === 'completed') {
      await tx.ad.update({ where: { id: bid.adId }, data: { status: 'completed' } })
    }

    notify(ad.userId, 'AD_TRADE_READY', 'Trade is now open!',
      `Buyer completed their details. Trade ${trade.orderRef} is open.`,
      { tradeId: trade.id }, trade.id)

    return trade
  })
}

export async function rejectAdBid(adOwnerUserId: string, bidId: string) {
  const bid = await db.adBid.findUnique({ where: { id: bidId }, include: { ad: true } })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.ad.userId !== adOwnerUserId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Bid is already ${bid.status}`, 409)

  await db.adBid.update({ where: { id: bidId }, data: { status: 'rejected' } })

  notify(bid.bidderId, 'AD_BID_REJECTED', 'Bid rejected', `Your bid on the USDT listing was declined.`, { bidId })
}

export async function cancelAdBid(bidderId: string, bidId: string) {
  const bid = await db.adBid.findUnique({ where: { id: bidId } })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.bidderId !== bidderId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Cannot cancel a bid with status: ${bid.status}`, 409)

  await db.adBid.update({ where: { id: bidId }, data: { status: 'cancelled' } })
}

export async function getAdActivity(adId: string, requestingUserId?: string) {
  const ad = await db.ad.findUnique({ where: { id: adId }, select: { userId: true } })
  if (!ad) throw new AppError('NOT_FOUND', 'Listing not found', 404)

  const isOwner = !!requestingUserId && requestingUserId === ad.userId

  const [bidAgg, activeTradeCount, completedTradeCount, lastTrade] = await Promise.all([
    db.adBid.aggregate({
      where: { adId, status: 'pending' },
      _count: { id: true },
      _min: { pricePerUnit: true },
      _max: { pricePerUnit: true },
    }),
    db.trade.count({ where: { adId, status: { in: ACTIVE_TRADE_STATUSES as TradeStatusLiteral[] } } }),
    db.trade.count({ where: { adId, status: 'crypto_released' as TradeStatusLiteral } }),
    db.trade.findFirst({
      where: { adId, status: 'crypto_released' as TradeStatusLiteral },
      orderBy: { updatedAt: 'desc' },
      select: { price: true, updatedAt: true },
    }),
  ])

  const base = {
    bids: {
      pendingCount: bidAgg._count.id ?? 0,
      minPrice: bidAgg._min.pricePerUnit?.toString() ?? null,
      maxPrice: bidAgg._max.pricePerUnit?.toString() ?? null,
    },
    trades: {
      activeCount: activeTradeCount,
      completedCount: completedTradeCount,
      lastTradePrice: lastTrade?.price?.toString() ?? null,
      lastTradeAt: lastTrade?.updatedAt ?? null,
    },
  }

  if (!isOwner) {
    let myBid = null
    if (requestingUserId) {
      myBid = await db.adBid.findFirst({
        where: { adId, bidderId: requestingUserId, status: { in: ['pending', 'accepted_pending_buyer'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, expiresAt: true, pricePerUnit: true, usdtAmount: true, fiatAmount: true },
      })
    }
    return { ...base, myBid: myBid ?? null }
  }

  const [bidItems, tradeItems] = await Promise.all([
    db.adBid.findMany({
      where: { adId, status: { in: ['pending', 'accepted_pending_buyer'] } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, pricePerUnit: true, usdtAmount: true, fiatAmount: true,
        message: true, status: true, expiresAt: true, createdAt: true,
        bidder: { select: { id: true, username: true } },
        trade: { select: { orderRef: true, status: true } },
      },
    }),
    db.trade.findMany({
      where: { adId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, orderRef: true, status: true, amount: true,
        price: true, fiatAmount: true,
        createdAt: true, updatedAt: true,
        buyer: { select: { username: true } },
        seller: { select: { username: true } },
      },
    }),
  ])

  return {
    ...base,
    bids: { ...base.bids, items: bidItems },
    trades: { ...base.trades, items: tradeItems },
  }
}

export async function getMyAdBids(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const where = { bidderId: userId }

  const [bids, total] = await Promise.all([
    db.adBid.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        ad: { include: { user: { select: { id: true, username: true } } } },
        trade: { select: { orderRef: true, status: true } },
      },
    }),
    db.adBid.count({ where }),
  ])

  return { bids, total, page, limit, totalPages: Math.ceil(total / limit) }
}
