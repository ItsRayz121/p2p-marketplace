import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import type { CtmSettlementType, CtmListingStatus } from '@prisma/client'

type Tx = Prisma.TransactionClient

const TIER_CAPS: Record<string, number> = {
  new: 5_000,
  basic: 25_000,
  verified: 100_000,
  elite: 1_000_000,
}

export interface CreateListingInput {
  tokenId: string
  side: 'buy' | 'sell'
  settlementType: CtmSettlementType
  pricePerUnit: number
  totalAmount: number
  minOrderPkr: number
  maxOrderPkr: number
  settlementMethod: string
  settlementNote: string
  paymentMethods: string[]
  tradeWindowMins?: number
  terms?: string
  requiresProof?: boolean
  proofInstructions?: string
  expiresAt?: Date
}

export interface ListingsFilter {
  tokenId?: string
  side?: string
  paymentMethod?: string
  minPkr?: number
  maxPkr?: number
  page?: number
  limit?: number
  merchantProfileId?: string
  status?: CtmListingStatus
  adminView?: boolean
}

export async function createListing(userId: string, data: CreateListingInput) {
  const merchantProfile = await db.ctmMerchantProfile.findUnique({
    where: { userId },
    include: { merchant: { select: { status: true } } },
  })
  if (!merchantProfile) throw new AppError('FORBIDDEN', 'You must be a registered CTM merchant to create listings', 403)
  if (!merchantProfile.isActive) throw new AppError('FORBIDDEN', 'Your CTM merchant profile is suspended', 403)

  const token = await db.ctmToken.findUnique({ where: { id: data.tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)
  if (token.status !== 'approved') throw new AppError('FORBIDDEN', 'Token is not approved for listing', 403)
  if (!token.isListingEnabled) throw new AppError('FORBIDDEN', 'Listings are disabled for this token', 403)

  const maxPkrPerTrade = TIER_CAPS[merchantProfile.tier] ?? 5_000
  if (data.maxOrderPkr > maxPkrPerTrade) {
    throw new AppError('FORBIDDEN', `Your merchant tier (${merchantProfile.tier}) allows max PKR ${maxPkrPerTrade} per trade`, 403)
  }

  if (token.maxListingAmount && new Prisma.Decimal(data.totalAmount).gt(token.maxListingAmount)) {
    throw new AppError('VALIDATION_ERROR', `Total amount exceeds token max listing amount of ${token.maxListingAmount}`, 400)
  }

  return db.ctmListing.create({
    data: {
      merchantProfileId: merchantProfile.id,
      tokenId: data.tokenId,
      side: data.side as never,
      settlementType: data.settlementType,
      priceType: 'fixed',
      pricePerUnit: new Prisma.Decimal(data.pricePerUnit),
      totalAmount: new Prisma.Decimal(data.totalAmount),
      availableAmount: new Prisma.Decimal(data.totalAmount),
      minOrderPkr: new Prisma.Decimal(data.minOrderPkr),
      maxOrderPkr: new Prisma.Decimal(data.maxOrderPkr),
      settlementMethod: data.settlementMethod,
      settlementNote: data.settlementNote,
      paymentMethods: data.paymentMethods,
      tradeWindowMins: data.tradeWindowMins ?? 45,
      terms: data.terms ?? '',
      requiresProof: data.requiresProof ?? true,
      proofInstructions: data.proofInstructions ?? null,
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    },
  })
}

export async function getListings(filters: ListingsFilter = {}) {
  const { tokenId, side, paymentMethod, minPkr, maxPkr, page = 1, limit = 20, merchantProfileId, status, adminView = false } = filters
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = adminView ? {} : { status: 'active' }
  if (tokenId) where.tokenId = tokenId
  if (side) where.side = side
  if (merchantProfileId) where.merchantProfileId = merchantProfileId
  if (status) where.status = status
  if (paymentMethod) where.paymentMethods = { has: paymentMethod }
  if (minPkr) where.maxOrderPkr = { gte: new Prisma.Decimal(minPkr) }
  if (maxPkr) where.minOrderPkr = { lte: new Prisma.Decimal(maxPkr) }

  const [listings, total] = await Promise.all([
    db.ctmListing.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ createdAt: 'desc' }],
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true, riskTier: true } },
        merchantProfile: {
          select: {
            id: true,
            tier: true,
            totalCtmTrades: true,
            completedCtmTrades: true,
            ctmAvgRating: true,
            user: { select: { id: true, username: true } },
          },
        },
      },
    }),
    db.ctmListing.count({ where }),
  ])

  return { listings, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getListingById(id: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id },
    include: {
      token: true,
      merchantProfile: {
        include: {
          user: { select: { id: true, username: true } },
        },
      },
    },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  return listing
}

export async function updateListing(userId: string, listingId: string, data: {
  pricePerUnit?: number
  minOrderPkr?: number
  maxOrderPkr?: number
  terms?: string
  paymentMethods?: string[]
  settlementNote?: string
  tradeWindowMins?: number
}) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true, tier: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)

  if (data.maxOrderPkr) {
    const maxPkrPerTrade = TIER_CAPS[listing.merchantProfile.tier] ?? 5_000
    if (data.maxOrderPkr > maxPkrPerTrade) {
      throw new AppError('FORBIDDEN', `Your merchant tier allows max PKR ${maxPkrPerTrade} per trade`, 403)
    }
  }

  if (data.pricePerUnit) {
    const activeTrades = await db.ctmTrade.count({
      where: { listingId, status: { in: ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] } },
    })
    if (activeTrades > 0) throw new AppError('CONFLICT', 'Cannot change price while there are active trades', 409)
  }

  return db.ctmListing.update({
    where: { id: listingId },
    data: {
      ...(data.pricePerUnit !== undefined ? { pricePerUnit: new Prisma.Decimal(data.pricePerUnit) } : {}),
      ...(data.minOrderPkr !== undefined ? { minOrderPkr: new Prisma.Decimal(data.minOrderPkr) } : {}),
      ...(data.maxOrderPkr !== undefined ? { maxOrderPkr: new Prisma.Decimal(data.maxOrderPkr) } : {}),
      ...(data.terms !== undefined ? { terms: data.terms } : {}),
      ...(data.paymentMethods !== undefined ? { paymentMethods: data.paymentMethods } : {}),
      ...(data.settlementNote !== undefined ? { settlementNote: data.settlementNote } : {}),
      ...(data.tradeWindowMins !== undefined ? { tradeWindowMins: data.tradeWindowMins } : {}),
    },
  })
}

export async function pauseListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)
  if (listing.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'paused' } })
}

export async function activateListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)
  if (listing.status !== 'paused') throw new AppError('CONFLICT', 'Listing is not paused', 409)
  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'active' } })
}

export async function deleteListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)

  const activeTrades = await db.ctmTrade.count({
    where: { listingId, status: { in: ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] } },
  })
  if (activeTrades > 0) throw new AppError('CONFLICT', 'Cannot delete listing with active trades', 409)

  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'cancelled' } })
}

export async function incrementLockedAmount(listingId: string, amount: Prisma.Decimal, tx: Tx) {
  await tx.ctmListing.update({
    where: { id: listingId },
    data: {
      availableAmount: { decrement: amount },
      lockedAmount: { increment: amount },
    },
  })
}

export async function decrementLockedAmount(listingId: string, amount: Prisma.Decimal, tx: Tx) {
  await tx.ctmListing.update({
    where: { id: listingId },
    data: {
      availableAmount: { increment: amount },
      lockedAmount: { decrement: amount },
    },
  })
}
