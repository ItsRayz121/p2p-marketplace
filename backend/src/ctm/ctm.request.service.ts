import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { generateCtmDisplayRef } from './ctm.ref'
import { assertTokenAddressFormat } from './ctm.address'
import { notify as centralNotify } from '../lib/notify'

const PM_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay', nayapay: 'NayaPay', bank_transfer: 'Bank Transfer',
}

// Immutable account snapshot stored on the trade (same shape as the listing flow).
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

// Delegate to the central notifier so CTM request events fire SSE + web-push.
function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  const tradeRef = typeof metadata.tradeRef === 'string' ? metadata.tradeRef : undefined
  centralNotify(userId, type, title, body, metadata, undefined, tradeRef ? `/ctm/trade/${tradeRef}` : undefined)
}

export interface CreateRequestInput {
  tokenId: string
  side: 'buy' | 'sell'
  amount: number
  targetPricePkr?: number
  paymentMethods: string[]
  note?: string
  expiryHours?: number
}

export interface RequestsFilter {
  tokenId?: string
  side?: string
  page?: number
  limit?: number
}

export async function createRequest(userId: string, data: CreateRequestInput) {
  const token = await db.ctmToken.findUnique({ where: { id: data.tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)
  if (token.status !== 'approved') throw new AppError('FORBIDDEN', 'Token is not approved', 403)

  const openCount = await db.ctmRequest.count({ where: { userId, status: 'open' } })
  if (openCount >= 3) throw new AppError('CONFLICT', 'You can have at most 3 open requests at a time', 409)

  const expiryHours = data.expiryHours ?? 2
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)

  return db.ctmRequest.create({
    data: {
      userId,
      tokenId: data.tokenId,
      side: data.side as never,
      amount: new Prisma.Decimal(data.amount),
      targetPricePkr: data.targetPricePkr ? new Prisma.Decimal(data.targetPricePkr) : null,
      paymentMethods: data.paymentMethods,
      note: data.note ?? null,
      expiresAt,
    },
  })
}

export async function getRequests(filters: RequestsFilter = {}) {
  const { tokenId, side, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = { status: 'open' }
  if (tokenId) where.tokenId = tokenId
  if (side) where.side = side

  const [requests, total] = await Promise.all([
    db.ctmRequest.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true } },
        user: { select: { id: true, username: true } },
        _count: { select: { bids: { where: { status: 'pending' } } } },
      },
    }),
    db.ctmRequest.count({ where }),
  ])

  return { requests, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getRequestById(requestId: string, viewerId?: string) {
  const request = await db.ctmRequest.findUnique({
    where: { id: requestId },
    include: {
      token: true,
      user: { select: { id: true, username: true } },
      bids: {
        where: { status: { not: 'withdrawn' } },
        orderBy: { pricePerUnit: 'asc' },
        include: {
          // Hide bidder identity unless viewer is request owner or admin
          bidder: { select: { id: true, username: true } },
        },
      },
    },
  })
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404)

  // Mask bidder names for non-owners
  if (viewerId !== request.userId) {
    request.bids = request.bids.map((b) => ({ ...b, bidder: { id: b.bidder.id, username: '***' } }))
  }

  return request
}

export async function getMyRequestsAndBids(userId: string) {
  const [requests, bids] = await Promise.all([
    db.ctmRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true } },
        bids: { where: { status: 'pending' }, orderBy: { pricePerUnit: 'asc' } },
        _count: { select: { bids: { where: { status: 'pending' } } } },
      },
    }),
    db.ctmBid.findMany({
      where: { bidderId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        request: {
          include: {
            token: { select: { id: true, slug: true, name: true, symbol: true } },
          },
        },
      },
    }),
  ])
  return { requests, bids }
}

export async function submitBid(bidderId: string, requestId: string, data: {
  pricePerUnit: number
  message?: string
  bidExpiryHours?: number
  paymentMethodId?: string     // bidder's account (PKR receiving if seller; pay-FROM if buyer)
  buyerSettlementId?: string   // bidder's token receiving address (only when bidder is the buyer)
}) {
  const request = await db.ctmRequest.findUnique({ where: { id: requestId }, include: { token: true } })
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404)
  if (request.status !== 'open') throw new AppError('CONFLICT', 'Request is not open', 409)
  if (request.userId === bidderId) throw new AppError('FORBIDDEN', 'Cannot bid on your own request', 403)
  if (new Date() > request.expiresAt) throw new AppError('CONFLICT', 'Request has expired', 409)

  const existingBid = await db.ctmBid.findFirst({
    where: { requestId, bidderId, status: 'pending' },
  })
  if (existingBid) throw new AppError('CONFLICT', 'You already have a pending bid on this request', 409)

  // On a SELL request the requester sells tokens, so the BIDDER is the buyer (pays
  // PKR + receives tokens). On a BUY request the bidder is the seller (receives PKR).
  const bidderIsBuyer = request.side === 'sell'

  // The bidder must declare the account they'll use, so the trade has real details.
  if (!data.paymentMethodId) {
    throw new AppError('VALIDATION_ERROR', bidderIsBuyer ? 'Select the account you will pay from' : 'Select the account where you want to receive payment', 400)
  }
  const bidderPm = await db.paymentMethod.findFirst({ where: { id: data.paymentMethodId, userId: bidderId } })
  if (!bidderPm) throw new AppError('VALIDATION_ERROR', 'Payment method not found or not yours', 400)

  if (bidderIsBuyer) {
    if (!data.buyerSettlementId?.trim()) throw new AppError('VALIDATION_ERROR', 'Enter your token receiving address', 400)
    assertTokenAddressFormat(request.token, data.buyerSettlementId, undefined)
  }

  const expiryHours = data.bidExpiryHours ?? 1
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)
  const totalPkr = new Prisma.Decimal(data.pricePerUnit).mul(request.amount)

  const bid = await db.ctmBid.create({
    data: {
      requestId,
      bidderId,
      pricePerUnit: new Prisma.Decimal(data.pricePerUnit),
      totalPkr,
      message: data.message ?? null,
      // Seller-bidder: their PKR receiving account. Buyer-bidder: pay-from + address.
      paymentMethods: bidderIsBuyer ? [] : [data.paymentMethodId],
      buyerPaymentMethodId: bidderIsBuyer ? data.paymentMethodId : null,
      buyerSettlementId: bidderIsBuyer ? data.buyerSettlementId!.trim() : null,
      expiresAt,
    },
  })

  notify(request.userId, 'CTM_BID_RECEIVED', 'New bid on your request', `A new bid of PKR ${totalPkr} has been submitted`, { requestId, bidId: bid.id })

  return bid
}

export async function withdrawBid(bidderId: string, requestId: string, bidId: string) {
  const bid = await db.ctmBid.findUnique({ where: { id: bidId } })
  if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.requestId !== requestId) throw new AppError('NOT_FOUND', 'Bid not found', 404)
  if (bid.bidderId !== bidderId) throw new AppError('FORBIDDEN', 'Not your bid', 403)
  if (bid.status !== 'pending') throw new AppError('CONFLICT', 'Bid is not pending', 409)

  return db.ctmBid.update({ where: { id: bidId }, data: { status: 'withdrawn' } })
}

export async function acceptBid(userId: string, requestId: string, bidId: string, data?: {
  paymentMethodId?: string   // requester's account (PKR receiving if seller; pay-FROM if buyer)
  settlementId?: string      // requester's token receiving address (only when requester is the buyer)
}) {
  return db.$transaction(async (tx) => {
    const request = await tx.ctmRequest.findUnique({
      where: { id: requestId },
      include: { token: true },
    })
    if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404)
    if (request.userId !== userId) throw new AppError('FORBIDDEN', 'Not your request', 403)
    if (request.status !== 'open') throw new AppError('CONFLICT', 'Request is no longer open', 409)

    const bid = await tx.ctmBid.findUnique({ where: { id: bidId } })
    if (!bid) throw new AppError('NOT_FOUND', 'Bid not found', 404)
    if (bid.requestId !== requestId) throw new AppError('NOT_FOUND', 'Bid not found on this request', 404)
    if (bid.status !== 'pending') throw new AppError('CONFLICT', 'Bid is not pending', 409)
    if (new Date() > bid.expiresAt) throw new AppError('CONFLICT', 'Bid has expired', 409)

    const isBuy = request.side === 'buy'
    const buyerId = isBuy ? request.userId : bid.bidderId
    const sellerId = isBuy ? bid.bidderId : request.userId

    // The requester confirms the account they'll use, so the trade has real details
    // for BOTH sides (the bidder's came in on the bid).
    if (!data?.paymentMethodId) {
      throw new AppError('VALIDATION_ERROR', isBuy ? 'Select the account you will pay from' : 'Select the account where you want to receive payment', 400)
    }
    const requesterPm = await tx.paymentMethod.findFirst({ where: { id: data.paymentMethodId, userId } })
    if (!requesterPm) throw new AppError('VALIDATION_ERROR', 'Payment method not found or not yours', 400)
    if (isBuy) {
      if (!data.settlementId?.trim()) throw new AppError('VALIDATION_ERROR', 'Enter your token receiving address', 400)
      assertTokenAddressFormat(request.token, data.settlementId, undefined)
    }

    // Resolve each role's account:
    //   seller PKR account  → buy request: the bidder's (bid.paymentMethods[0]); sell request: the requester's
    //   buyer pay-from      → buy request: the requester's; sell request: the bidder's (bid.buyerPaymentMethodId)
    //   buyer receiving addr→ buy request: the requester's (data.settlementId); sell request: the bidder's (bid.buyerSettlementId)
    const sellerPmId = isBuy ? bid.paymentMethods[0] : data.paymentMethodId
    const buyerPmId  = isBuy ? data.paymentMethodId : bid.buyerPaymentMethodId
    const buyerAddr  = (isBuy ? data.settlementId?.trim() : bid.buyerSettlementId) ?? null

    const sellerPm = sellerPmId ? await tx.paymentMethod.findFirst({ where: { id: sellerPmId, userId: sellerId } }) : null
    const buyerPm  = buyerPmId ? await tx.paymentMethod.findFirst({ where: { id: buyerPmId, userId: buyerId } }) : null
    const sellerPaymentSnapshot = sellerPm ? buildAccountSnapshot(sellerPm) : undefined
    const buyerPaymentSnapshot  = buyerPm ? buildAccountSnapshot(buyerPm) : undefined

    const expiresAt = new Date(Date.now() + 45 * 60 * 1000)

    const trade = await tx.ctmTrade.create({
      data: {
        displayRef: await generateCtmDisplayRef(tx),
        requestId,
        buyerId,
        sellerId,
        tokenId: request.tokenId,
        settlementType: request.token.settlementType,
        tokenAmount: request.amount,
        pricePerUnit: bid.pricePerUnit,
        fiatAmount: bid.totalPkr,
        paymentMethod: sellerPmId ?? '',
        settlementMethod: buyerAddr ?? '',
        buyerSettlementId: buyerAddr,
        ...(sellerPaymentSnapshot ? { sellerPaymentSnapshot: sellerPaymentSnapshot as never } : {}),
        ...(buyerPaymentSnapshot ? { buyerPaymentSnapshot: buyerPaymentSnapshot as never } : {}),
        expiresAt,
      },
    })

    // Accept bid, reject all others, mark request accepted
    await tx.ctmBid.update({ where: { id: bidId }, data: { status: 'accepted' } })
    await tx.ctmBid.updateMany({
      where: { requestId, id: { not: bidId }, status: 'pending' },
      data: { status: 'rejected' },
    })
    await tx.ctmRequest.update({
      where: { id: requestId },
      data: { status: 'accepted', acceptedBidId: bidId },
    })

    notify(bid.bidderId, 'CTM_BID_ACCEPTED', 'Your bid was accepted!', `Your bid of PKR ${bid.totalPkr} has been accepted. Go to trade room to complete.`, { tradeRef: trade.tradeRef, requestId })

    return trade
  })
}

export async function cancelRequest(userId: string, requestId: string) {
  const request = await db.ctmRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError('NOT_FOUND', 'Request not found', 404)
  if (request.userId !== userId) throw new AppError('FORBIDDEN', 'Not your request', 403)
  if (request.status !== 'open') throw new AppError('CONFLICT', 'Request is not open', 409)

  await db.$transaction([
    db.ctmRequest.update({ where: { id: requestId }, data: { status: 'cancelled' } }),
    db.ctmBid.updateMany({ where: { requestId, status: 'pending' }, data: { status: 'rejected' } }),
  ])
}
