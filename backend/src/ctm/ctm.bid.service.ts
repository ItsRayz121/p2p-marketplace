import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { notify } from '../lib/notify'

type Tx = Prisma.TransactionClient

const PM_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank Transfer',
}

function buildAccountSnapshot(pm: { type: string; accountName: string; bankName: string | null; mobileNumber: string | null; ibanNumber: string | null; accountNumber: string | null }) {
  return {
    type: pm.type,
    label: pm.type === 'bank_transfer' ? (pm.bankName ?? 'Bank Transfer') : (PM_LABELS[pm.type] ?? pm.type),
    accountName: pm.accountName,
    ...(pm.mobileNumber ? { mobileNumber: pm.mobileNumber } : {}),
    ...(pm.bankName ? { bankName: pm.bankName } : {}),
    ...(pm.ibanNumber ? { ibanNumber: pm.ibanNumber } : {}),
    ...(pm.accountNumber ? { accountNumber: pm.accountNumber } : {}),
  }
}

export async function placeBid(
  bidderId: string,
  listingId: string,
  data: {
    pricePerUnit: number
    tokenAmount: number
    message?: string
    paymentMethod?: string
    paymentMethods?: string[]
    buyerSettlementId?: string
    buyerPaymentMethodId?: string
  },
) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: true, token: true },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  if (!listing.merchantProfile.isActive) throw new AppError('CONFLICT', 'Merchant is not active', 409)
  if (listing.merchantProfile.userId === bidderId) throw new AppError('CONFLICT', 'Cannot bid on your own listing', 409)

  const isBuyListing = listing.side === 'buy'

  // Validate payment method(s) are provided
  if (!isBuyListing && !data.paymentMethod) {
    throw new AppError('VALIDATION_ERROR', 'paymentMethod is required', 400)
  }
  if (!isBuyListing && !listing.paymentMethods.includes(data.paymentMethod!)) {
    throw new AppError('CONFLICT', 'Payment method not supported by this listing', 409)
  }
  if (isBuyListing) {
    const ids = data.paymentMethods?.length ? data.paymentMethods : (data.paymentMethod ? [data.paymentMethod] : [])
    if (ids.length === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one payment receiving account', 400)
  }

  const tradeTokenAmount = new Prisma.Decimal(data.tokenAmount)
  if (tradeTokenAmount.lte(0)) throw new AppError('VALIDATION_ERROR', 'Token amount must be greater than 0', 400)
  if (tradeTokenAmount.gt(listing.availableAmount)) throw new AppError('VALIDATION_ERROR', 'Requested amount exceeds available listing amount', 400)
  if (tradeTokenAmount.lt(listing.minOrderTokens)) throw new AppError('VALIDATION_ERROR', `Minimum order is ${listing.minOrderTokens.toString()} ${listing.token.symbol}`, 400)
  if (tradeTokenAmount.gt(listing.maxOrderTokens)) throw new AppError('VALIDATION_ERROR', `Maximum order is ${listing.maxOrderTokens.toString()} ${listing.token.symbol}`, 400)

  const pricePerUnit = new Prisma.Decimal(data.pricePerUnit)
  if (pricePerUnit.lte(0)) throw new AppError('VALIDATION_ERROR', 'Bid price must be greater than 0', 400)

  const fiatAmount = pricePerUnit.mul(tradeTokenAmount)
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min

  const resolvedPaymentMethods = isBuyListing
    ? (data.paymentMethods?.length ? data.paymentMethods : (data.paymentMethod ? [data.paymentMethod] : []))
    : []

  const bid = await db.ctmListingBid.create({
    data: {
      listingId,
      bidderId,
      pricePerUnit,
      tokenAmount: tradeTokenAmount,
      fiatAmount,
      message: data.message ?? null,
      paymentMethod: !isBuyListing ? (data.paymentMethod ?? null) : (resolvedPaymentMethods[0] ?? null),
      paymentMethods: isBuyListing ? resolvedPaymentMethods : [],
      buyerSettlementId: !isBuyListing ? (data.buyerSettlementId ?? null) : null,
      buyerPaymentMethodId: !isBuyListing ? (data.buyerPaymentMethodId ?? null) : null,
      status: 'pending',
      expiresAt,
    },
  })

  // Notify merchant
  notify(
    listing.merchantProfile.userId,
    'CTM_BID_RECEIVED',
    'New bid on your listing',
    `Someone offered PKR ${pricePerUnit.toNumber().toLocaleString()} per ${listing.token.symbol} on your listing`,
    { bidId: bid.id, listingId },
  )

  return bid
}

export async function acceptListingBid(merchantUserId: string, bidId: string) {
  const bid = await db.ctmListingBid.findUnique({
    where: { id: bidId },
    include: {
      listing: {
        include: { token: true, merchantProfile: { include: { user: true } } },
      },
      bidder: { select: { id: true, username: true } },
    },
  })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.listing.merchantProfile.userId !== merchantUserId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Bid is already ${bid.status}`, 409)
  if (new Date() > bid.expiresAt) throw new AppError('CONFLICT', 'Bid has expired', 409)

  const listing = bid.listing
  const isBuyListing = listing.side === 'buy'
  const actualBuyerId = isBuyListing ? listing.merchantProfile.userId : bid.bidderId
  const actualSellerId = isBuyListing ? bid.bidderId : listing.merchantProfile.userId

  // Resolve payment method IDs
  const primaryPaymentMethodId = isBuyListing
    ? (bid.paymentMethods[0] ?? bid.paymentMethod ?? '')
    : (bid.paymentMethod ?? '')
  const resolvedPaymentMethodIds = isBuyListing ? bid.paymentMethods : [primaryPaymentMethodId]

  // Build seller payment snapshot
  const paymentMethodOwnerId = isBuyListing ? bid.bidderId : listing.merchantProfile.userId
  let sellerPaymentSnapshot: Record<string, unknown>

  if (isBuyListing && resolvedPaymentMethodIds.length > 1) {
    const methods = await db.paymentMethod.findMany({
      where: { id: { in: resolvedPaymentMethodIds }, userId: paymentMethodOwnerId },
    })
    if (methods.length !== resolvedPaymentMethodIds.length) {
      throw new AppError('CONFLICT', 'One or more payment methods no longer exist', 409)
    }
    sellerPaymentSnapshot = { accounts: methods.map(buildAccountSnapshot) }
  } else {
    const sellerPm = await db.paymentMethod.findFirst({
      where: { id: primaryPaymentMethodId, userId: paymentMethodOwnerId },
    })
    if (!sellerPm) throw new AppError('CONFLICT', 'Payment method no longer exists', 409)
    sellerPaymentSnapshot = buildAccountSnapshot(sellerPm)
  }

  // Build buyer payment snapshot (SELL listings only)
  let buyerPaymentSnapshot: Record<string, unknown> | null = null
  if (!isBuyListing && bid.buyerPaymentMethodId) {
    const buyerPm = await db.paymentMethod.findFirst({
      where: { id: bid.buyerPaymentMethodId, userId: bid.bidderId },
    })
    if (buyerPm) buyerPaymentSnapshot = buildAccountSnapshot(buyerPm)
  }

  const actualBuyerSettlementId = isBuyListing
    ? (listing.settlementMethod ?? null)
    : (bid.buyerSettlementId ?? null)

  const expiresAt = new Date(Date.now() + (listing.tradeWindowMins ?? 45) * 60 * 1000)
  const fiatAmount = bid.pricePerUnit.mul(bid.tokenAmount)
  const feePct = parseFloat(process.env.CTM_PLATFORM_FEE_PCT ?? '0.5') / 100
  const platformFeePkr = fiatAmount.mul(feePct)
  const isOnChain = listing.settlementType === 'ON_CHAIN'
  const escrowAddress = isOnChain ? (process.env.PLATFORM_USDT_WALLET ?? null) : null
  const escrowCurrency = isOnChain ? (process.env.PLATFORM_ESCROW_CURRENCY ?? 'USDT_TRC20') : null
  const escrowAmount = isOnChain ? fiatAmount : null

  return db.$transaction(async (tx: Tx) => {
    // Atomic availability check
    const updated = await tx.ctmListing.updateMany({
      where: { id: listing.id, availableAmount: { gte: bid.tokenAmount } },
      data: {
        availableAmount: { decrement: bid.tokenAmount },
        lockedAmount: { increment: bid.tokenAmount },
      },
    })
    if (updated.count === 0) throw new AppError('CONFLICT', 'Listing no longer has enough available tokens', 409)

    // Reject all other pending bids on this listing
    await tx.ctmListingBid.updateMany({
      where: { listingId: listing.id, status: 'pending', id: { not: bidId } },
      data: { status: 'rejected' },
    })

    const trade = await tx.ctmTrade.create({
      data: {
        listingBidId: bid.id,
        listingId: listing.id,
        buyerId: actualBuyerId,
        sellerId: actualSellerId,
        tokenId: listing.tokenId,
        settlementType: listing.settlementType,
        tokenAmount: bid.tokenAmount,
        pricePerUnit: bid.pricePerUnit,
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

    await tx.ctmListingBid.update({
      where: { id: bidId },
      data: { status: 'accepted' },
    })

    notify(bid.bidderId, 'CTM_BID_ACCEPTED', 'Your bid was accepted!', `Your bid on ${listing.token.symbol} was accepted. Trade is now open.`, { tradeRef: trade.tradeRef })

    return trade
  })
}

export async function rejectListingBid(merchantUserId: string, bidId: string) {
  const bid = await db.ctmListingBid.findUnique({
    where: { id: bidId },
    include: { listing: { include: { merchantProfile: true, token: true } } },
  })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.listing.merchantProfile.userId !== merchantUserId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Bid is already ${bid.status}`, 409)

  await db.ctmListingBid.update({ where: { id: bidId }, data: { status: 'rejected' } })

  notify(bid.bidderId, 'CTM_BID_REJECTED', 'Bid rejected', `Your bid on ${bid.listing.token.symbol} was declined by the merchant.`, { bidId })
}

export async function cancelListingBid(bidderId: string, bidId: string) {
  const bid = await db.ctmListingBid.findUnique({ where: { id: bidId } })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.bidderId !== bidderId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', `Cannot cancel a bid with status: ${bid.status}`, 409)

  await db.ctmListingBid.update({ where: { id: bidId }, data: { status: 'cancelled' } })
}

export async function getListingBids(listingId: string, merchantUserId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: true },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== merchantUserId) throw new AppError('FORBIDDEN', 'Access denied', 403)

  return db.ctmListingBid.findMany({
    where: { listingId },
    orderBy: { createdAt: 'desc' },
    include: {
      bidder: { select: { id: true, username: true } },
      trade: { select: { tradeRef: true, status: true } },
    },
  })
}

export async function getMyBids(userId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const where = { bidderId: userId }

  const [bids, total] = await Promise.all([
    db.ctmListingBid.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        listing: {
          include: {
            token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true } },
            merchantProfile: { include: { user: { select: { id: true, username: true } } } },
          },
        },
        trade: { select: { tradeRef: true, status: true } },
      },
    }),
    db.ctmListingBid.count({ where }),
  ])

  return { bids, total, page, limit, totalPages: Math.ceil(total / limit) }
}
